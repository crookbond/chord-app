/**
 * Bind/unbind external IM channels to Chord groups (ADR 0010).
 *
 * Examples:
 *   npm run connector:bind --workspace=server -- bind slack C0123 g_abc
 *   npm run connector:bind --workspace=server -- list g_abc
 *   npm run connector:bind --workspace=server -- unbind slack C0123
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import {
  bindChannel,
  listBindingsForGroup,
  unbindChannel,
} from '../services/connectors/channel-resolver.js';
import type { ConnectorPlatform } from '../services/connectors/types.js';

const PLATFORMS: ConnectorPlatform[] = ['slack', 'discord', 'telegram', 'whatsapp'];

function fail(msg: string): never {
  console.error(msg);
  console.error(
    '\nUsage:\n' +
      '  bind <platform> <externalChannelId> <groupId> [configJson]\n' +
      '  unbind <platform> <externalChannelId>\n' +
      '  list <groupId>\n' +
      `\nplatform ∈ {${PLATFORMS.join(', ')}}`,
  );
  process.exit(1);
}

function isPlatform(s: string): s is ConnectorPlatform {
  return (PLATFORMS as string[]).includes(s);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) fail('missing command');

  ensureDataDirs();
  const db = openDb();
  try {
    if (cmd === 'bind') {
      const [platform, channel, groupId, alias, configJson] = rest;
      if (!platform || !channel || !groupId) fail('bind needs <platform> <channel> <groupId> [alias] [configJson]');
      if (!isPlatform(platform)) fail(`unknown platform: ${platform}`);
      const aliasOrDefault = alias && alias.length > 0 ? alias : platform;
      await bindChannel(db, platform, channel, groupId, aliasOrDefault, configJson ?? null);
      console.log(`bound ${platform}:${channel} (alias=${aliasOrDefault}) → ${groupId}`);
    } else if (cmd === 'unbind') {
      const [platform, channel] = rest;
      if (!platform || !channel) fail('unbind needs <platform> <channel>');
      if (!isPlatform(platform)) fail(`unknown platform: ${platform}`);
      const removed = await unbindChannel(db, platform, channel);
      console.log(removed ? `unbound ${platform}:${channel}` : 'no binding found');
    } else if (cmd === 'list') {
      const [groupId] = rest;
      if (!groupId) fail('list needs <groupId>');
      const bindings = await listBindingsForGroup(db, groupId);
      if (bindings.length === 0) {
        console.log(`no bindings for ${groupId}`);
      } else {
        for (const b of bindings) {
          console.log(`${b.platform}:${b.externalChannelId}`);
        }
      }
    } else {
      fail(`unknown command: ${cmd}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
