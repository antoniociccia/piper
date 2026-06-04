import { describe, expect, test } from 'bun:test';

import { parseSlashCommand } from '../../../src/tui/commands.ts';

describe('tui/commands — non-slash input', () => {
  test('returns null for prose input', () => {
    expect(parseSlashCommand('check uptime on staging')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('tui/commands — /help and /quit and /save', () => {
  test('/help', () => {
    const r = parseSlashCommand('/help');
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.command.kind).toBe('help');
  });

  test('/q quits', () => {
    const r = parseSlashCommand('/q');
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.command.kind).toBe('quit');
  });

  test('/save without filename', () => {
    const r = parseSlashCommand('/save');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'save') {
      expect(r.command.filename).toBeUndefined();
    }
  });

  test('/save report.md', () => {
    const r = parseSlashCommand('/save report.md');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'save') {
      expect(r.command.filename).toBe('report.md');
    }
  });
});

describe('tui/commands — /env list and /env remove', () => {
  test('/env list', () => {
    const r = parseSlashCommand('/env list');
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.command.kind).toBe('env-list');
  });

  test('/env ls aliases list', () => {
    const r = parseSlashCommand('/env ls');
    expect(r?.ok).toBe(true);
    if (r?.ok) expect(r.command.kind).toBe('env-list');
  });

  test('/env remove staging', () => {
    const r = parseSlashCommand('/env remove staging');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-remove') {
      expect(r.command.name).toBe('staging');
    }
  });

  test('/env remove without name returns error', () => {
    const r = parseSlashCommand('/env remove');
    expect(r?.ok).toBe(false);
  });
});

describe('tui/commands — /env add', () => {
  test('basic /env add staging deploy@host', () => {
    const r = parseSlashCommand('/env add staging deploy@host.example.com');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.name).toBe('staging');
      expect(r.command.sshUser).toBe('deploy');
      expect(r.command.host).toBe('host.example.com');
      expect(r.command.port).toBeUndefined();
    }
  });

  test('/env add with port', () => {
    const r = parseSlashCommand('/env add s deploy@10.0.0.5:2222');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.port).toBe(2222);
    }
  });

  test('/env add with --key', () => {
    const r = parseSlashCommand('/env add s deploy@h --key /Users/me/.ssh/id_ed25519');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.identityFile).toBe('/Users/me/.ssh/id_ed25519');
    }
  });

  test('/env add with -i short flag', () => {
    const r = parseSlashCommand('/env add s deploy@h -i ~/.ssh/key');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.identityFile).toBe('~/.ssh/key');
    }
  });

  test('/env add with --desc quoted', () => {
    const r = parseSlashCommand('/env add s deploy@h --desc "the staging web tier"');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.description).toBe('the staging web tier');
    }
  });

  test('/env add with --tag', () => {
    const r = parseSlashCommand('/env add s deploy@h --tag staging,web,critical');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.tags).toEqual(['staging', 'web', 'critical']);
    }
  });

  test('/env add with everything', () => {
    const r = parseSlashCommand(
      '/env add prod ubuntu@10.0.0.5:2222 --key ~/.ssh/prod_key --desc "prod web" --tag prod,web',
    );
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'env-add') {
      expect(r.command.name).toBe('prod');
      expect(r.command.sshUser).toBe('ubuntu');
      expect(r.command.host).toBe('10.0.0.5');
      expect(r.command.port).toBe(2222);
      expect(r.command.identityFile).toBe('~/.ssh/prod_key');
      expect(r.command.description).toBe('prod web');
      expect(r.command.tags).toEqual(['prod', 'web']);
    }
  });

  test('/env add rejects bad name', () => {
    const r = parseSlashCommand('/env add 1bad deploy@h');
    expect(r?.ok).toBe(false);
  });

  test('/env add rejects malformed target', () => {
    const r = parseSlashCommand('/env add s nouser-no-at-sign');
    expect(r?.ok).toBe(false);
  });

  test('/env add rejects unknown flag', () => {
    const r = parseSlashCommand('/env add s deploy@h --weird foo');
    expect(r?.ok).toBe(false);
  });
});

describe('tui/commands — /watch', () => {
  test('/watch with no args opens the picker', () => {
    const r = parseSlashCommand('/watch');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'watch') {
      expect(r.command.target).toBeUndefined();
    } else {
      throw new Error('expected a watch command');
    }
  });

  test('/watch <single-token> targets a plan by name', () => {
    const r = parseSlashCommand('/watch staging-health');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'watch') {
      expect(r.command.target).toBe('staging-health');
    } else {
      throw new Error('expected a watch command');
    }
  });

  test('/watch <multiple words> is a free-text compile request', () => {
    const r = parseSlashCommand('/watch keep an eye on staging');
    expect(r?.ok).toBe(true);
    if (r?.ok && r.command.kind === 'watch') {
      expect(r.command.target).toBe('keep an eye on staging');
    } else {
      throw new Error('expected a watch command');
    }
  });

  test('/w is not a recognised alias (removed)', () => {
    const r = parseSlashCommand('/w');
    expect(r?.ok).toBe(false);
  });
});

describe('parseSlashCommand — annex & skill', () => {
  test('/annex with no title', () => {
    const r = parseSlashCommand('/annex');
    expect(r).toEqual({ ok: true, command: { kind: 'annex' } });
  });
  test('/annex with a multi-word title', () => {
    const r = parseSlashCommand('/annex redis OOM postmortem');
    expect(r).toEqual({ ok: true, command: { kind: 'annex', title: 'redis OOM postmortem' } });
  });
  test('/skill with no target lists', () => {
    const r = parseSlashCommand('/skill');
    expect(r).toEqual({ ok: true, command: { kind: 'skill' } });
  });
  test('/skill <name>', () => {
    const r = parseSlashCommand('/skill django-stack');
    expect(r).toEqual({ ok: true, command: { kind: 'skill', target: 'django-stack' } });
  });
});

describe('tui/commands — unknown commands', () => {
  test('/unknown returns error', () => {
    const r = parseSlashCommand('/unknown');
    expect(r?.ok).toBe(false);
  });

  test('/env with no subcommand returns error', () => {
    const r = parseSlashCommand('/env');
    expect(r?.ok).toBe(false);
  });
});
