// What ships beside the commands: the skills held in the binary, the pinned browser's
// installer (never a real download here), and the Claude Code plugin files.
//
//   cargo build && npm run test:package

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { repoRoot } from '../spikes/lib/serve.mjs';

const binary = join(repoRoot, 'target', 'debug', 'scanline');
const scratch = mkdtempSync(join(tmpdir(), 'scanline-pack-'));
const home = join(scratch, 'home');
const env = { ...process.env, SCANLINE_HOME: home };

delete env.SCANLINE_BROWSER;

function scanline (...args)
{
    return new Promise((resolve) =>
    {
        execFile(binary, args, { env, timeout: 60000 }, (error, stdout, stderr) =>
        {
            resolve({ code: error ? error.code ?? 1 : 0, out: (stdout + stderr).trim() });
        });
    });
}

after(() => rmSync(scratch, { recursive: true, force: true }));

describe('skills', () =>
{
    const names = readdirSync(join(repoRoot, 'skills')).sort();

    test('the binary holds every skill in the repository, word for word', async () =>
    {
        const listed = await scanline('skill');

        assert.equal(listed.code, 0, listed.out);

        for (const name of names)
        {
            assert.match(listed.out, new RegExp(`^  ${name} `, 'm'));

            const printed = await scanline('skill', name);

            assert.equal(printed.out, readFileSync(join(repoRoot, 'skills', name, 'SKILL.md'), 'utf8').trim(), name);
        }

        assert.equal(names.length, 7);
        assert.equal(existsSync(join(home, 'control.sock')), false, 'no host was started');
    });

    test('a short name finds a skill, a wrong one lists them, and --to writes the folders', async () =>
    {
        const short = await scanline('skill', 'wrong-pixels');

        assert.match(short.out, /^---\nname: scanline-wrong-pixels\n/);

        const wrong = await scanline('skill', 'nonsense');

        assert.notEqual(wrong.code, 0);
        assert.match(wrong.out, /There is no skill "nonsense"\.[\s\S]*scanline-memory/);

        const to = join(scratch, 'agent-skills');
        const wrote = await scanline('skill', '--to', to);

        assert.equal(wrote.code, 0, wrote.out);
        assert.match(wrote.out, /^Wrote 7 skills of scanline \d/);
        assert.deepEqual(readdirSync(to).sort(), names);
        assert.equal(readFileSync(join(to, 'scanline-play', 'SKILL.md'), 'utf8'), readFileSync(join(repoRoot, 'skills', 'scanline-play', 'SKILL.md'), 'utf8'));
    });
});

describe('the pinned browser', () =>
{
    test('a dry run says what would happen and touches nothing', async () =>
    {
        const dry = await scanline('browser', 'install', '--dry-run');

        assert.equal(dry.code, 0, dry.out);
        assert.match(dry.out, /^Dry run: nothing was downloaded or written\./);
        assert.match(dry.out, /https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/\d+\.\d+\.\d+\.\d+\/[a-z0-9-]+\/chrome-[a-z0-9-]+\.zip/);
        assert.equal(existsSync(join(home, 'browser')), false);

        const status = await scanline('browser');

        assert.match(status.out, /Pinned version: Chrome for Testing [\d.]+, not installed/);
    });

    test('an archive is unpacked into place, and one that is not the browser is refused', { skip: process.platform !== 'darwin' }, async () =>
    {
        const version = /Chrome for Testing ([\d.]+)/.exec((await scanline('browser')).out)[1];
        const platform = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';

        // Not the browser: an archive of something else.
        const other = join(scratch, 'other');

        mkdirSync(join(other, 'something'), { recursive: true });
        writeFileSync(join(other, 'something', 'file.txt'), 'hello\n');
        execFileSync('ditto', ['-c', '-k', join(other), join(scratch, 'other.zip')]);

        const refused = await scanline('browser', 'install', '--from', join(scratch, 'other.zip'));

        assert.notEqual(refused.code, 0);
        assert.match(refused.out, /is not Chrome for Testing for this platform/);
        assert.equal(existsSync(join(home, 'browser', version)), false);
        assert.deepEqual(readdirSync(join(home, 'browser')), [], 'nothing half-unpacked is left');

        // A stand-in with the archive's layout. Nothing is downloaded and nothing is run.
        const app = join(scratch, 'fake', `chrome-${platform}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS');

        mkdirSync(app, { recursive: true });
        writeFileSync(join(app, 'Google Chrome for Testing'), '#!/bin/sh\nexit 0\n');
        chmodSync(join(app, 'Google Chrome for Testing'), 0o755);
        execFileSync('ditto', ['-c', '-k', join(scratch, 'fake'), join(scratch, 'fake.zip')]);

        const installed = await scanline('browser', 'install', '--from', join(scratch, 'fake.zip'));

        assert.equal(installed.code, 0, installed.out);
        assert.match(installed.out, new RegExp(`^Installed Chrome for Testing ${version.replaceAll('.', '\\.')} at `));

        const status = await scanline('browser');

        assert.match(status.out, /A launch would use: .*Google Chrome for Testing \(the pinned Chrome for Testing/);
        assert.match((await scanline('browser', 'install')).out, /is already installed/);
    });
});

describe('the Claude Code plugin', () =>
{
    test('the manifest, the marketplace entry and the binary agree', async () =>
    {
        const plugin = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
        const market = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
        const version = (await scanline('--version')).out;

        assert.equal(`scanline ${plugin.version}`, version);
        assert.equal(plugin.name, 'scanline');
        assert.deepEqual(plugin.mcpServers.scanline, { command: 'scanline', args: ['mcp'] });
        assert.equal(market.plugins.length, 1);
        assert.equal(market.plugins[0].name, plugin.name);
        assert.equal(market.plugins[0].source, './');
        assert.ok(market.owner.name);

        // A release is refused when the versions drift apart.
        assert.match(execFileSync('node', [join(repoRoot, 'tools', 'package.mjs'), '--check'], { encoding: 'utf8' }), /^Versions agree: /);
    });
});
