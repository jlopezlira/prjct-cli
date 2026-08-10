/**
 * Secure storage for the Cloud API token.
 *
 * The token must never be persisted in auth.json. auth.json is metadata only;
 * the secret lives in the platform credential store. If no secure store is
 * available, login fails instead of falling back to plaintext.
 */

import { spawn } from 'node:child_process'
import { execFileAsync } from '../utils/exec'
import { commandOnPath } from '../utils/which'

const MACOS_SERVICE = 'prjct-cli-auth'
const ACCOUNT = 'prjct-cloud'
const LINUX_SCHEMA = 'app.prjct.cli.auth'
const WINDOWS_TARGET = 'prjct-cli-auth'

export type AuthTokenLocation = 'keychain' | 'secret-service' | 'credential-manager' | 'none'

export interface AuthTokenStore {
  get(): Promise<string | null>
  set(value: string): Promise<AuthTokenLocation>
  clear(): Promise<void>
  location(): Promise<AuthTokenLocation>
}

const authTokenState: {
  cached: string | null | undefined
  testStore: AuthTokenStore | null
} = { cached: undefined, testStore: null }

function isDarwin(): boolean {
  return process.platform === 'darwin'
}

function isLinux(): boolean {
  return process.platform === 'linux'
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

function runWithStdin(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: string[] = []
    const stderr: string[] = []

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout.push(String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(String(chunk))
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.join(''))
        return
      }
      reject(new Error(stderr.join('').trim() || `${command} exited with code ${code}`))
    })

    child.stdin.end(input)
  })
}

async function readMacosKeychain(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      ACCOUNT,
      '-s',
      MACOS_SERVICE,
      '-w',
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function writeMacosKeychain(value: string): Promise<void> {
  await execFileAsync('security', [
    'add-generic-password',
    '-U',
    '-a',
    ACCOUNT,
    '-s',
    MACOS_SERVICE,
    '-w',
    value,
  ])
}

async function clearMacosKeychain(): Promise<void> {
  try {
    await execFileAsync('security', ['delete-generic-password', '-a', ACCOUNT, '-s', MACOS_SERVICE])
  } catch {
    /* not present */
  }
}

async function readLinuxSecretService(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('secret-tool', [
      'lookup',
      'service',
      LINUX_SCHEMA,
      'account',
      ACCOUNT,
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function writeLinuxSecretService(value: string): Promise<void> {
  await runWithStdin(
    'secret-tool',
    ['store', '--label', 'prjct Cloud token', 'service', LINUX_SCHEMA, 'account', ACCOUNT],
    value
  )
}

async function clearLinuxSecretService(): Promise<void> {
  try {
    await execFileAsync('secret-tool', ['clear', 'service', LINUX_SCHEMA, 'account', ACCOUNT])
  } catch {
    /* not present */
  }
}

const WINDOWS_CREDENTIAL_SCRIPT = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class PrjctCredentialManager {
  private const uint CRED_TYPE_GENERIC = 1;
  private const uint CRED_PERSIST_LOCAL_MACHINE = 2;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr buffer);

  public static string Read(string target) {
    IntPtr credentialPtr;
    if (!CredRead(target, CRED_TYPE_GENERIC, 0, out credentialPtr)) {
      return "";
    }

    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(credentialPtr, typeof(CREDENTIAL));
      if (credential.CredentialBlobSize == 0 || credential.CredentialBlob == IntPtr.Zero) {
        return "";
      }

      byte[] secretBytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, secretBytes, 0, secretBytes.Length);
      return Encoding.Unicode.GetString(secretBytes);
    } finally {
      CredFree(credentialPtr);
    }
  }

  public static void Write(string target, string account, string secret) {
    byte[] secretBytes = Encoding.Unicode.GetBytes(secret);
    if (secretBytes.Length > 5120) {
      throw new InvalidOperationException("Credential is too large for Windows Credential Manager.");
    }

    IntPtr secretPtr = Marshal.AllocHGlobal(secretBytes.Length);
    try {
      Marshal.Copy(secretBytes, 0, secretPtr, secretBytes.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = CRED_TYPE_GENERIC;
      credential.TargetName = target;
      credential.UserName = account;
      credential.CredentialBlob = secretPtr;
      credential.CredentialBlobSize = (uint)secretBytes.Length;
      credential.Persist = CRED_PERSIST_LOCAL_MACHINE;

      if (!CredWrite(ref credential, 0)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      byte[] zeros = new byte[secretBytes.Length];
      Marshal.Copy(zeros, 0, secretPtr, zeros.Length);
      Marshal.FreeHGlobal(secretPtr);
    }
  }

  public static void Delete(string target) {
    CredDelete(target, CRED_TYPE_GENERIC, 0);
  }
}
`

function powershellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
}

function windowsCommand(command: string): string {
  return `${WINDOWS_CREDENTIAL_SCRIPT}\nAdd-Type -TypeDefinition $code -Language CSharp\n${command}`.replace(
    WINDOWS_CREDENTIAL_SCRIPT,
    `$code = @'\n${WINDOWS_CREDENTIAL_SCRIPT}\n'@`
  )
}

async function readWindowsCredentialManager(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      powershellArgs(windowsCommand(`[PrjctCredentialManager]::Read('${WINDOWS_TARGET}')`))
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function writeWindowsCredentialManager(value: string): Promise<void> {
  const command = windowsCommand(`
$secret = [Console]::In.ReadToEnd()
[PrjctCredentialManager]::Write('${WINDOWS_TARGET}', '${ACCOUNT}', $secret)
`)
  await runWithStdin('powershell.exe', powershellArgs(command), value)
}

async function clearWindowsCredentialManager(): Promise<void> {
  try {
    await execFileAsync(
      'powershell.exe',
      powershellArgs(windowsCommand(`[PrjctCredentialManager]::Delete('${WINDOWS_TARGET}')`))
    )
  } catch {
    /* not present */
  }
}

async function platformGet(): Promise<string | null> {
  if (isDarwin()) return readMacosKeychain()
  if (isWindows()) return readWindowsCredentialManager()
  if (isLinux()) return readLinuxSecretService()
  return null
}

/**
 * Whether this process can use a platform credential store right now.
 * Used to fail login early with an actionable message (no plaintext fallback).
 */
export async function hasSecureCredentialStore(): Promise<boolean> {
  if (isDarwin()) {
    // `security` is part of macOS; treat as available if the binary resolves.
    try {
      await execFileAsync('security', ['help'])
      return true
    } catch {
      return false
    }
  }
  if (isWindows()) {
    // Credential Manager via PowerShell/advapi32 — require powershell.exe.
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'])
      return true
    } catch {
      return false
    }
  }
  if (isLinux()) {
    // secret-tool (libsecret) is the Linux path; WSL/headless without it → false.
    return commandOnPath('secret-tool')
  }
  return false
}

async function platformSet(value: string): Promise<AuthTokenLocation> {
  const token = value.trim()
  if (!token) throw new Error('Refusing to store an empty Cloud API token.')

  if (isDarwin()) {
    await writeMacosKeychain(token)
    return 'keychain'
  }

  if (isWindows()) {
    await writeWindowsCredentialManager(token)
    return 'credential-manager'
  }

  if (isLinux()) {
    if (!(await hasSecureCredentialStore())) {
      throw new Error(
        'No secure credential store available (install libsecret / secret-tool). Refusing to store the Cloud API token in plaintext on Linux/WSL.'
      )
    }
    await writeLinuxSecretService(token)
    return 'secret-service'
  }

  throw new Error(
    'No secure credential store is available for this platform. Refusing to store the Cloud API token in plaintext.'
  )
}

async function platformClear(): Promise<void> {
  if (isDarwin()) await clearMacosKeychain()
  if (isWindows()) await clearWindowsCredentialManager()
  if (isLinux()) await clearLinuxSecretService()
}

async function platformLocation(): Promise<AuthTokenLocation> {
  if (isDarwin() && (await readMacosKeychain())) return 'keychain'
  if (isWindows() && (await readWindowsCredentialManager())) return 'credential-manager'
  if (isLinux() && (await readLinuxSecretService())) return 'secret-service'
  return 'none'
}

function activeStore(): AuthTokenStore {
  return (
    authTokenState.testStore ?? {
      get: platformGet,
      set: platformSet,
      clear: platformClear,
      location: platformLocation,
    }
  )
}

export async function getAuthToken(): Promise<string | null> {
  // Auth can change from a different `prjct` process while the daemon is
  // alive. Do not let a long-running process keep a stale token or stale
  // unauthenticated state in memory.
  authTokenState.cached = await activeStore().get()
  return authTokenState.cached
}

export async function setAuthToken(value: string): Promise<AuthTokenLocation> {
  // Refuse empty before any store call — no backend may treat "" as a valid
  // Cloud API token, and nothing may fall through to plaintext auth.json.
  const token = value.trim()
  if (!token) {
    throw new Error('Refusing to store an empty Cloud API token.')
  }
  const location = await activeStore().set(token)
  authTokenState.cached = token
  return location
}

export async function clearAuthToken(): Promise<void> {
  authTokenState.cached = null
  await activeStore().clear()
}

export function _setAuthTokenStoreForTests(store: AuthTokenStore | null): void {
  authTokenState.testStore = store
  authTokenState.cached = undefined
}
