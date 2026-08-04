/**
 * CONTRACTS section 5.1: consume every spec/fixtures/*.json verbatim and assert
 * displayState after each event for every session listed in `expect`.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { displayStateOf, reduce } from '../src/core/reducer.js';
import { emptyModel, type NormalizedEvent } from '../src/core/types.js';
import { fixturesDir } from './helpers.js';

// No test may spawn osascript, notify-send or tmux (real banners, real dialogs).
process.env.CCTAP_NO_EXEC = '1';
process.env.CCTAP_NOTIFY = 'off';

interface FixtureFile {
  name: string;
  description?: string;
  events: NormalizedEvent[];
  expect: Record<string, string>[];
}

const files = fs
  .readdirSync(fixturesDir())
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('reducer fixtures', () => {
  it('finds every acceptance fixture', () => {
    assert.ok(files.length >= 6, `expected the six spec fixtures, found ${files.length}`);
    assert.ok(files.includes('delegated-turn.json'), 'the R8 acceptance fixture is present');
    assert.ok(files.includes('subagent-bookkeeping.json'), 'the R1 identity fixture is present');
  });

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(join(fixturesDir(), file), 'utf8')) as FixtureFile;

    it(`${fixture.name}: events and expectations line up`, () => {
      assert.equal(
        fixture.events.length,
        fixture.expect.length,
        `${file}: ${fixture.events.length} events vs ${fixture.expect.length} expectations`,
      );
    });

    it(`${fixture.name}: displayState after every event`, () => {
      let model = emptyModel();
      fixture.events.forEach((ev, i) => {
        model = reduce(model, ev);
        const want = fixture.expect[i] as Record<string, string>;
        for (const [sessionId, expected] of Object.entries(want)) {
          const s = model.sessions[sessionId];
          assert.ok(s, `${file} step ${i} (${ev.event}): session ${sessionId} missing`);
          assert.equal(
            s.displayState,
            expected,
            `${file} step ${i} (${ev.event}${ev.notif ? `/${ev.notif}` : ''}): ` +
              `${sessionId} is ${s.displayState}, expected ${expected}`,
          );
          // The stored displayState must always equal the derivation.
          assert.equal(s.displayState, displayStateOf(s), `${file} step ${i}: stored displayState drifted`);
        }
      });
    });

    it(`${fixture.name}: stateSince only moves when displayState changes`, () => {
      let model = emptyModel();
      let previous: Record<string, { display: string; since: number }> = {};
      fixture.events.forEach((ev, i) => {
        model = reduce(model, ev);
        const now: Record<string, { display: string; since: number }> = {};
        for (const [id, s] of Object.entries(model.sessions)) {
          now[id] = { display: s.displayState, since: s.stateSince };
          const before = previous[id];
          if (before) {
            if (before.display === s.displayState) {
              assert.equal(s.stateSince, before.since, `${file} step ${i}: ${id} stateSince moved without a change`);
            } else {
              assert.equal(s.stateSince, ev.ts, `${file} step ${i}: ${id} stateSince should be the event ts`);
            }
          }
        }
        previous = now;
      });
    });
  }
});
