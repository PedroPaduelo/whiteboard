/**
 * HelpDialog.jsx — the keyboard map, rendered from the SAME table the key
 * handler runs (shortcuts.js `groupedShortcuts`), so the sheet cannot list a
 * key that does something else.
 */

import React from 'react';
import { useUi } from './uiStore.js';
import { Dialog } from './Dialog.jsx';
import { KeyCaps } from './common.jsx';
import { groupedShortcuts } from './shortcuts.js';
import { t } from './strings.js';

const GROUPS = groupedShortcuts();

export function HelpDialog() {
  const open = useUi((s) => s.helpOpen);
  if (!open) return null;
  const close = () => useUi.getState().close('helpOpen');
  return (
    <Dialog title={t.help.title} onClose={close} size="lg" testId="help-dialog" footer={<p className="help-foot">{t.help.footer}</p>}>
      <p className="help-intro">{t.help.intro}</p>
      <div className="help-grid">
        {GROUPS.map((g) => (
          <section key={g.group} className="help-group">
            <h3 className="help-group__title">{g.title}</h3>
            <ul className="help-list">
              {g.items.map((item) => (
                <li key={item.id} className="help-row">
                  <span className="help-row__label">{item.label}</span>
                  <span className="help-row__keys">
                    {item.chords.map((caps, i) => (
                      <React.Fragment key={i}>
                        {i > 0 ? <span className="help-row__or">{t.help.or}</span> : null}
                        <KeyCaps caps={caps} />
                      </React.Fragment>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

export default HelpDialog;
