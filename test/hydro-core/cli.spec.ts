import { describe, expect, it } from 'vitest'

import { validateCliCommand } from '../../src/hydro/cli.js'

describe('validateCliCommand', () => {
  it('accepts safe hydrooj arguments and strips the prefix', () => {
    expect(validateCliCommand('backup --dbOnly')).toBe('backup --dbOnly')
    expect(validateCliCommand('hydrooj cli system get server.url')).toBe('cli system get server.url')
    expect(validateCliCommand('restore /data/backup-1.zip -y')).toContain('restore')
  })

  it('rejects shell metacharacters and empty commands', () => {
    expect(() => validateCliCommand('backup; rm -rf /')).toThrow(/控制字符/)
    expect(() => validateCliCommand('backup && reboot')).toThrow(/控制字符/)
    expect(() => validateCliCommand('backup | tee /tmp/x')).toThrow(/控制字符/)
    expect(() => validateCliCommand('backup $(whoami)')).toThrow(/控制字符/)
    expect(() => validateCliCommand('   ')).toThrow(/请输入/)
  })
})
