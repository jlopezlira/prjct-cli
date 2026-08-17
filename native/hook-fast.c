/*
 * prjct-hook-fast — native fast path for warm-daemon hook forwarding.
 *
 * Scope is intentionally narrow: this binary does exactly ONE job — forward
 * a Claude Code hook event to an already-running prjct daemon over its Unix
 * socket and relay the response. It exists purely to remove the ~10-25ms of
 * interpreted-runtime process-boot cost (bun/node starting up) that the
 * bun-based shim pays on every single hook fire, for the single most common
 * case: a warm daemon, a hook command, a normal response.
 *
 * On ANY uncertainty BEFORE stdin is read — socket missing, connect not yet
 * attempted — this binary exits non-zero WITHOUT writing anything to stdout,
 * so a caller chaining with `||` (see core/services/hook-command.ts
 * hookCommandChain()) safely falls through to the bun-based shim with the
 * stdin pipe untouched.
 *
 * Once stdin HAS been read, the next stage's pipe is drained — so before
 * punting (daemon timeout, stale-code `retry`, malformed response) the
 * payload is SPILLED to a deterministic scratch file in the daemon run dir
 * (`hook-stdin-<fnv1a32(cwd)>-<subcommand>.json`; see
 * core/hooks/stdin-spill.ts) and this binary exits non-zero with no output.
 * Every portable stdin reader (daemon shim, cold-entry, bin fast path)
 * checks for a fresh spill before reading stdin, so the fallback re-runs
 * the hook with the real event payload instead of silently degrading to
 * `{}`. Only when the spill itself fails (disk full, missing run dir) does
 * this binary fall back to the old self-resolving `{}` + exit 0 contract.
 * It never prints partial output before deciding to punt.
 *
 * The bun-based shim keeps the full cold-path, non-hook-command, and
 * Windows logic. This binary deliberately does NOT reimplement any of that
 * — it is an additive speed layer, never the only path.
 *
 * Wire protocol matches core/types/daemon.ts DaemonRequest/DaemonResponse
 * exactly (newline-terminated JSON over the Unix socket) — see
 * generateDaemonShim() in scripts/build.js for the reference JS
 * implementation this mirrors. Any change to that wire protocol MUST be
 * reflected here too.
 *
 * POSIX only (macOS/Linux). Windows uses named pipes with a different API
 * entirely and is not yet covered — the bun-based shim remains the only
 * path there (directHookPrefix() in settings-installer.ts already special-
 * cases process.platform==='win32').
 */

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* Exit code signaling "I could not confidently handle this — try the
 * fallback." Any value other than 0 works for shell `||` purposes; this one
 * is chosen to be unlikely to collide with a real hook exit code (which are
 * 0 in every case this codebase's fail-soft hook contract produces). */
#define FALLTHROUGH_EXIT 89

#define STDIN_TIMEOUT_MS 1000
#define RESPONSE_TIMEOUT_MS 800
/* session-start fires ONCE per session and does the heaviest build, so it
 * earns a wider response budget than per-turn events — still far below the
 * 10s host-side hook timeout (settings-installer HOOK_TIMEOUT_SECONDS). */
#define SESSION_START_RESPONSE_TIMEOUT_MS 4000
#define MAX_STDIN_BYTES (1 * 1024 * 1024)
#define MAX_RESPONSE_BYTES (4 * 1024 * 1024)

static void fall_through(void) {
    exit(FALLTHROUGH_EXIT);
}

/* Last-resort self-resolution: emit the empty-JSON no-op and exit 0. Used
 * ONLY when stdin was consumed but the payload could NOT be spilled for the
 * next chain stage (see punt() below) — e.g. the run dir is gone or the
 * disk is full. Matches the bun shim's own `soft()` contract. */
static void soft_fail(void) {
    fputs("{}\n", stdout);
    fflush(stdout);
    exit(0);
}

/* ---------- growable buffer ---------- */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} buf_t;

static int buf_init(buf_t *b, size_t initial_cap) {
    b->data = malloc(initial_cap);
    if (!b->data) return -1;
    b->len = 0;
    b->cap = initial_cap;
    return 0;
}

static int buf_reserve(buf_t *b, size_t additional) {
    if (b->len + additional <= b->cap) return 0;
    size_t newcap = b->cap * 2;
    while (newcap < b->len + additional) newcap *= 2;
    char *n = realloc(b->data, newcap);
    if (!n) return -1;
    b->data = n;
    b->cap = newcap;
    return 0;
}

static int buf_append(buf_t *b, const char *s, size_t n) {
    if (buf_reserve(b, n) != 0) return -1;
    memcpy(b->data + b->len, s, n);
    b->len += n;
    return 0;
}

static int buf_append_str(buf_t *b, const char *s) {
    return buf_append(b, s, strlen(s));
}

/* fnv1a-32 over the raw bytes of `s`. MUST match fnv1a32hex() in
 * core/hooks/stdin-spill.ts exactly — both sides compute the spill path
 * independently (a C process cannot export env vars to the next command in
 * a shell `||` chain, so the path must be deterministic). */
static unsigned int fnv1a32(const char *s) {
    unsigned int h = 2166136261u;
    while (*s) {
        h ^= (unsigned char)*s++;
        h *= 16777619u;
    }
    return h;
}

/* Spill the consumed stdin payload to
 * `<run_dir>/hook-stdin-<fnv1a32hex(cwd)>-<subcommand>.json` so the NEXT
 * stage of the shell `||` chain can re-read it (its stdin pipe is already
 * drained). Returns 0 on success. The run dir is known to exist (the
 * daemon socket stat succeeded there before stdin was read). */
static int spill_stdin(const char *run_dir, const char *cwd, const char *subcommand,
                       const buf_t *stdin_buf) {
    /* Sanitize the subcommand to lowercase [a-z0-9-] — mirrors
     * sanitizeSubcommand() in core/hooks/stdin-spill.ts. */
    char sub[64];
    size_t j = 0;
    for (const char *p = subcommand; *p && j < sizeof(sub) - 1; p++) {
        char c = *p;
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') sub[j++] = c;
    }
    sub[j] = '\0';
    if (j == 0) return -1;

    char path[PATH_MAX + 256];
    snprintf(path, sizeof(path), "%s/hook-stdin-%08x-%s.json", run_dir, fnv1a32(cwd), sub);

    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return -1;
    size_t off = 0;
    while (off < stdin_buf->len) {
        ssize_t n = write(fd, stdin_buf->data + off, stdin_buf->len - off);
        if (n <= 0) { close(fd); unlink(path); return -1; }
        off += (size_t)n;
    }
    if (close(fd) != 0) { unlink(path); return -1; }
    return 0;
}

/* Failure AFTER stdin was consumed: spill the payload for the next chain
 * stage and punt (exit 89, no output) so the shell `||` fallback re-runs
 * the hook with the real event payload. Only when the spill itself fails
 * do we self-resolve to the `{}` no-op — the old always-soft contract. */
static void punt(const char *run_dir, const char *cwd, const char *subcommand,
                 const buf_t *stdin_buf) {
    if (spill_stdin(run_dir, cwd, subcommand, stdin_buf) == 0) fall_through();
    soft_fail();
}

/* ---------- JSON string escaping (for building the request) ---------- */

static int json_escape_append(buf_t *out, const char *s, size_t s_len) {
    for (size_t i = 0; i < s_len; i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  if (buf_append_str(out, "\\\"") != 0) return -1; break;
            case '\\': if (buf_append_str(out, "\\\\") != 0) return -1; break;
            case '\n': if (buf_append_str(out, "\\n") != 0) return -1; break;
            case '\r': if (buf_append_str(out, "\\r") != 0) return -1; break;
            case '\t': if (buf_append_str(out, "\\t") != 0) return -1; break;
            case '\b': if (buf_append_str(out, "\\b") != 0) return -1; break;
            case '\f': if (buf_append_str(out, "\\f") != 0) return -1; break;
            default:
                if (c < 0x20) {
                    char esc[8];
                    snprintf(esc, sizeof(esc), "\\u%04x", c);
                    if (buf_append_str(out, esc) != 0) return -1;
                } else {
                    if (buf_reserve(out, 1) != 0) return -1;
                    out->data[out->len++] = (char)c;
                }
        }
    }
    return 0;
}

/* ---------- JSON response scanning (targeted, not a general parser) ----------
 * We control both ends of this protocol (this repo), so we only need to
 * extract three known fields from a flat JSON object: retry (bool),
 * exitCode (number), stdout (string). Scanning is escape-aware so a `"` or
 * `:` inside an escaped string value can never be mistaken for structure. */

/* Find `"key":` in [start,end) at the OBJECT's top level (not inside a
 * string). Returns pointer just past the colon, or NULL. */
static const char *find_key(const char *start, const char *end, const char *key) {
    size_t key_len = strlen(key);
    int in_string = 0;
    for (const char *p = start; p < end; p++) {
        if (in_string) {
            if (*p == '\\' && p + 1 < end) { p++; continue; }
            if (*p == '"') in_string = 0;
            continue;
        }
        if (*p == '"') {
            in_string = 1;
            /* Check for `"key"` starting here. */
            if ((size_t)(end - p) > key_len + 2 &&
                p[1 + key_len] == '"' &&
                memcmp(p + 1, key, key_len) == 0) {
                const char *after_key = p + 2 + key_len;
                while (after_key < end && (*after_key == ' ' || *after_key == '\t')) after_key++;
                if (after_key < end && *after_key == ':') {
                    in_string = 0;
                    return after_key + 1;
                }
            }
        }
    }
    return NULL;
}

/* Parse a JSON string value starting at `p` (which must point at the
 * opening `"`). Appends the UNESCAPED bytes to `out`. Returns a pointer
 * just past the closing `"`, or NULL on malformed input. */
static const char *parse_json_string(const char *p, const char *end, buf_t *out) {
    if (p >= end || *p != '"') return NULL;
    p++;
    while (p < end && *p != '"') {
        if (*p == '\\' && p + 1 < end) {
            char e = p[1];
            char c = 0;
            switch (e) {
                case '"': c = '"'; break;
                case '\\': c = '\\'; break;
                case '/': c = '/'; break;
                case 'n': c = '\n'; break;
                case 'r': c = '\r'; break;
                case 't': c = '\t'; break;
                case 'b': c = '\b'; break;
                case 'f': c = '\f'; break;
                case 'u': {
                    if (p + 5 >= end) return NULL;
                    unsigned int cp = 0;
                    for (int i = 0; i < 4; i++) {
                        char h = p[2 + i];
                        cp <<= 4;
                        if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
                        else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
                        else return NULL;
                    }
                    /* UTF-8 encode. Surrogate pairs collapse to '?' — hook
                     * stdout in practice is markdown/JSON status text, not
                     * astral-plane content; good enough for this fast path
                     * (worst case a rare glyph renders as '?', never a crash
                     * or corrupted response). */
                    if (cp < 0x80) {
                        char b = (char)cp;
                        if (buf_append(out, &b, 1) != 0) return NULL;
                    } else if (cp < 0x800) {
                        char b[2] = { (char)(0xC0 | (cp >> 6)), (char)(0x80 | (cp & 0x3F)) };
                        if (buf_append(out, b, 2) != 0) return NULL;
                    } else {
                        char b[3] = {
                            (char)(0xE0 | (cp >> 12)),
                            (char)(0x80 | ((cp >> 6) & 0x3F)),
                            (char)(0x80 | (cp & 0x3F)),
                        };
                        if (buf_append(out, b, 3) != 0) return NULL;
                    }
                    p += 6;
                    continue;
                }
                default: return NULL;
            }
            if (buf_append(out, &c, 1) != 0) return NULL;
            p += 2;
            continue;
        }
        if (buf_append(out, p, 1) != 0) return NULL;
        p++;
    }
    if (p >= end) return NULL; /* unterminated string */
    return p + 1;
}

/* ---------- stdin reading, with a timeout so a host that never closes
 * stdin can't hang this process forever (falls through instead). ---------- */

static int read_stdin_with_timeout(buf_t *out, int timeout_ms) {
    struct timeval deadline;
    gettimeofday(&deadline, NULL);
    deadline.tv_sec += timeout_ms / 1000;
    deadline.tv_usec += (timeout_ms % 1000) * 1000;
    if (deadline.tv_usec >= 1000000) { deadline.tv_sec++; deadline.tv_usec -= 1000000; }

    char chunk[65536];
    for (;;) {
        struct timeval now;
        gettimeofday(&now, NULL);
        long remaining_ms = (deadline.tv_sec - now.tv_sec) * 1000 + (deadline.tv_usec - now.tv_usec) / 1000;
        if (remaining_ms <= 0) return 0; /* timed out — return whatever we have */

        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(0, &rfds);
        struct timeval tv;
        tv.tv_sec = remaining_ms / 1000;
        tv.tv_usec = (remaining_ms % 1000) * 1000;

        int sel = select(1, &rfds, NULL, NULL, &tv);
        if (sel <= 0) return 0; /* timeout or error — return what we have */

        ssize_t n = read(0, chunk, sizeof(chunk));
        if (n <= 0) return 0; /* EOF or error — done */
        if (out->len + (size_t)n > MAX_STDIN_BYTES) n = (ssize_t)(MAX_STDIN_BYTES - out->len);
        if (n > 0 && buf_append(out, chunk, (size_t)n) != 0) return -1;
        if (out->len >= MAX_STDIN_BYTES) return 0;
    }
}

int main(int argc, char **argv) {
    /* ---- Phase 1: BEFORE stdin is touched. fall_through() here is safe —
     * the next stage in the shell `||` chain gets a fully untouched pipe. */
    if (argc < 2) fall_through();
    const char *subcommand = argv[1];

    /* Must match every other entry point's PRJCT_NO_DAEMON contract
     * (scripts/build.js generateDaemonShim, bin/prjct.ts): "1" forces the
     * daemon-disabled path everywhere else, so this binary — which only
     * exists to talk to the daemon — has nothing to do when it's set. */
    const char *no_daemon = getenv("PRJCT_NO_DAEMON");
    if (no_daemon && strcmp(no_daemon, "1") == 0) fall_through();

    const char *home = getenv("HOME");
    if (!home || !*home) fall_through();

    const char *cli_home_env = getenv("PRJCT_CLI_HOME");
    char run_dir[PATH_MAX + 128];
    char sock_path[PATH_MAX + 256];
    if (cli_home_env && *cli_home_env) {
        snprintf(run_dir, sizeof(run_dir), "%s/run", cli_home_env);
    } else {
        snprintf(run_dir, sizeof(run_dir), "%s/.prjct-cli/run", home);
    }
    snprintf(sock_path, sizeof(sock_path), "%s/daemon.sock", run_dir);

    struct stat st;
    if (stat(sock_path, &st) != 0) fall_through(); /* no daemon listening */

    /* ---- Phase 2: stdin consumption starts here. From this point on the
     * pipe is drained for any later chain stage, so failures PUNT: spill the
     * payload to the run dir and exit non-zero (no output) so the shell `||`
     * fallback re-reads it from the spill file (core/hooks/stdin-spill.ts).
     * soft_fail() (`{}` + exit 0) remains only for the cases where no spill
     * is possible — getcwd failure (no path key) or a failed spill write. */
    char cwd[PATH_MAX + 256];
    if (!getcwd(cwd, sizeof(cwd))) fall_through(); /* nothing read yet */

#define PUNT() punt(run_dir, cwd, subcommand, &stdin_buf)
    buf_t stdin_buf;
    if (buf_init(&stdin_buf, 4096) != 0) fall_through(); /* nothing read yet */
    if (read_stdin_with_timeout(&stdin_buf, STDIN_TIMEOUT_MS) != 0) PUNT();

    /* Build the request line: {"id":"...","command":"hook","args":["<sub>"],"options":{},"cwd":"...","stdin":"..."[,"hookHost":"..."]}\n
     * hookHost forwards the invoking host's PRJCT_HOOK_HOST (kimi/cursor/
     * gemini install it inline in their hook command) so the daemon adapts
     * hook output for the right host — its own env never carries the var.
     * Mirrors the same field in bin/prjct.ts and generateDaemonShim(). */
    const char *hook_host = getenv("PRJCT_HOOK_HOST");
    buf_t req;
    if (buf_init(&req, stdin_buf.len + 512) != 0) PUNT();
    char id[64];
    snprintf(id, sizeof(id), "hf-%ld-%d", (long)time(NULL), (int)getpid());
    if (buf_append_str(&req, "{\"id\":\"") != 0) PUNT();
    if (json_escape_append(&req, id, strlen(id)) != 0) PUNT();
    if (buf_append_str(&req, "\",\"command\":\"hook\",\"args\":[\"") != 0) PUNT();
    if (json_escape_append(&req, subcommand, strlen(subcommand)) != 0) PUNT();
    if (buf_append_str(&req, "\"],\"options\":{},\"cwd\":\"") != 0) PUNT();
    if (json_escape_append(&req, cwd, strlen(cwd)) != 0) PUNT();
    if (buf_append_str(&req, "\",\"stdin\":\"") != 0) PUNT();
    if (json_escape_append(&req, stdin_buf.data, stdin_buf.len) != 0) PUNT();
    if (buf_append_str(&req, "\"") != 0) PUNT();
    if (hook_host && hook_host[0]) {
        if (buf_append_str(&req, ",\"hookHost\":\"") != 0) PUNT();
        if (json_escape_append(&req, hook_host, strlen(hook_host)) != 0) PUNT();
        if (buf_append_str(&req, "\"") != 0) PUNT();
    }
    if (buf_append_str(&req, "}\n") != 0) PUNT();

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) PUNT();

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (strlen(sock_path) >= sizeof(addr.sun_path)) { close(fd); PUNT(); }
    strncpy(addr.sun_path, sock_path, sizeof(addr.sun_path) - 1);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) { close(fd); PUNT(); }

    /* Response timeout via SO_RCVTIMEO — Unix domain socket connects are
     * local and effectively instantaneous (or fail immediately), so only
     * the response wait needs a deadline. session-start fires once per
     * session and does the heaviest build, so it earns a wider budget. */
    const int response_budget_ms =
        strcmp(subcommand, "session-start") == 0
            ? SESSION_START_RESPONSE_TIMEOUT_MS
            : RESPONSE_TIMEOUT_MS;
    struct timeval rcvtimeo;
    rcvtimeo.tv_sec = response_budget_ms / 1000;
    rcvtimeo.tv_usec = (response_budget_ms % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rcvtimeo, sizeof(rcvtimeo));

    size_t written = 0;
    while (written < req.len) {
        ssize_t n = write(fd, req.data + written, req.len - written);
        if (n <= 0) { close(fd); PUNT(); }
        written += (size_t)n;
    }

    buf_t resp;
    if (buf_init(&resp, 4096) != 0) { close(fd); PUNT(); }
    for (;;) {
        char chunk[65536];
        ssize_t n = read(fd, chunk, sizeof(chunk));
        if (n < 0) { close(fd); PUNT(); } /* includes EAGAIN/EWOULDBLOCK from SO_RCVTIMEO */
        if (n == 0) { close(fd); PUNT(); } /* daemon closed without a full line */
        if (resp.len + (size_t)n > MAX_RESPONSE_BYTES) { close(fd); PUNT(); }
        if (buf_append(&resp, chunk, (size_t)n) != 0) { close(fd); PUNT(); }
        if (memchr(resp.data, '\n', resp.len)) break;
    }
    close(fd);

    /* Response line found — scan it (up to the first \n) for the 3 fields
     * we need. Everything after the newline (there shouldn't be anything;
     * the daemon writes exactly one line) is ignored. */
    char *nl = memchr(resp.data, '\n', resp.len);
    const char *body_end = nl ? nl : (resp.data + resp.len);

    const char *p;

    p = find_key(resp.data, body_end, "retry");
    if (p) {
        while (p < body_end && *p == ' ') p++;
        /* Daemon's code is stale; request did NOT execute. Punt with the
         * payload spilled so the fallback re-runs the hook on the FRESH
         * code — the bun shim's own sendHook() can't do this (it has no
         * run-dir spill step) and degrades to a soft {} no-op instead. */
        if (p + 4 <= body_end && memcmp(p, "true", 4) == 0) PUNT();
    }

    long exit_code = 0;
    p = find_key(resp.data, body_end, "exitCode");
    if (p) {
        while (p < body_end && *p == ' ') p++;
        char *num_end = NULL;
        exit_code = strtol(p, &num_end, 10);
        if (num_end == p) exit_code = 0;
    }

    p = find_key(resp.data, body_end, "stdout");
    if (p) {
        while (p < body_end && *p == ' ') p++;
        buf_t out;
        if (buf_init(&out, resp.len) != 0) PUNT();
        const char *after = parse_json_string(p, body_end, &out);
        if (!after) PUNT(); /* malformed — let the fallback re-run, don't guess */
        fwrite(out.data, 1, out.len, stdout);
        fflush(stdout);
        return (int)exit_code;
    }

    /* No stdout field in an otherwise-valid response: still a successful
     * round trip, just nothing to print (mirrors the bun shim's
     * `if(r.stdout)process.stdout.write(r.stdout)` — writes only when
     * present, either way exits with the daemon's stated code). */
    return (int)exit_code;
}
#undef PUNT
