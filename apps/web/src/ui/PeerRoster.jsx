/**
 * PeerRoster.jsx — the presence avatars in the top bar.
 *
 * Design decisions worth stating:
 *   - Colour comes from `colorForPeer(peer.id)`, a hash of the id, so the same
 *     person is the same colour on every machine and across reconnects
 *     without the server persisting anything. When the server DID assign a
 *     colour we prefer it, because that is the one the other participants
 *     see.
 *   - "You're the only one here" is an explicit state. An empty roster is
 *     ambiguous — a broken presence channel looks exactly like being alone,
 *     and the user deserves to know which one it is.
 *   - The stack caps at 5 and expands on click; beyond that the `+N` bubble
 *     keeps the top bar from reflowing every time someone joins.
 */

import React, { useMemo, useState } from 'react';
import { colorForPeer } from '@whiteboard/shared';
import { useStore } from './store.js';
import { IconUsers } from './Icons.jsx';
import { TOOL_LABELS } from './shortcuts.js';

const VISIBLE_CAP = 5;

function initials(name) {
  const n = String(name || '').trim();
  if (!n) return '?';
  const parts = n.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function Avatar({ peer, isSelf, onSelect }) {
  const color = peer.color || colorForPeer(peer.id);
  const toolLabel = peer.tool ? TOOL_LABELS[peer.tool] ?? peer.tool : null;
  const tip = [
    peer.name || 'Anonymous',
    isSelf ? '(you)' : null,
    toolLabel ? `using ${toolLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      className="roster__avatar"
      style={{ '--peer-color': color }}
      data-self={isSelf ? 'true' : 'false'}
      title={tip}
      aria-label={tip}
      onClick={() => onSelect?.(peer)}
    >
      {initials(peer.name)}
    </button>
  );
}

export function PeerRoster() {
  const peers = useStore((s) => s.peers ?? []);
  const myPeerId = useStore((s) => s.myPeerId ?? null);
  const [expanded, setExpanded] = useState(false);

  // Newest-arrival last, you first: the top bar should not shuffle as the
  // server re-sends the roster with the same members in a new order.
  const ordered = useMemo(() => {
    const list = [...(peers ?? [])];
    list.sort((a, b) => {
      if (a.id === myPeerId) return -1;
      if (b.id === myPeerId) return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    return list;
  }, [peers, myPeerId]);

  const alone = ordered.length <= 1;

  if (alone) {
    return (
      <span
        className="roster"
        title="Nobody else is on this board yet. Share the link to collaborate."
        style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}
      >
        <IconUsers size={16} />
        <span>You&apos;re the only one here</span>
      </span>
    );
  }

  const visible = expanded ? ordered : ordered.slice(0, VISIBLE_CAP);
  const hidden = ordered.length - visible.length;

  return (
    <span className="roster" role="group" aria-label={`${ordered.length} people on this board`}>
      {visible.map((p) => (
        <Avatar key={p.id} peer={p} isSelf={p.id === myPeerId} onSelect={() => setExpanded(false)} />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="roster__more"
          onClick={() => setExpanded(true)}
          aria-label={`Show ${hidden} more`}
          title="Show everyone"
        >
          +{hidden}
        </button>
      ) : ordered.length > VISIBLE_CAP && expanded ? (
        <button
          type="button"
          className="roster__more"
          onClick={() => setExpanded(false)}
          aria-label="Collapse the roster"
        >
          −
        </button>
      ) : null}
    </span>
  );
}

export default PeerRoster;
