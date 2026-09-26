import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {StateWatcher} from './lib/state-reader.js';

// Rendering only reads `intent` (T302's fixed vocabulary), never `status`, so
// a new status can never appear in the top bar without an explicit label.
const ICON_BY_INTENT = {
    quiet: 'utilities-terminal-symbolic',
    active: 'media-playback-start-symbolic',
    attention: 'dialog-password-symbolic',
    complete: 'object-select-symbolic',
    error: 'dialog-error-symbolic',
    unknown: 'dialog-warning-symbolic',
};

function statePath() {
    // Mirrors src/core/paths.ts so a developer can point the extension at a
    // disposable test directory without touching real Claude state.
    const override = GLib.getenv('AGENTBAR_STATE_DIR');
    const directory = override && GLib.path_is_absolute(override)
        ? override
        : GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state', 'agentbar']);
    return GLib.build_filenamev([directory, 'state.json']);
}

export default class AgentBarExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        this._icon = new St.Icon({
            icon_name: ICON_BY_INTENT.quiet,
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: 'AgentBar',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'agentbar-indicator-label',
        });
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(this._icon);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._renderUnavailable('Reading state...');
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._watcher = new StateWatcher(statePath(), {
            onView: (view) => this._renderView(view),
            onUnavailable: (message) => {
                // The message comes from parseSnapshot or a Gio I/O error, both of
                // which are already safe diagnostic text - never raw session data.
                console.log(`AgentBar: state unavailable - ${message}`);
                this._renderUnavailable('Status unavailable');
            },
            onNotifications: () => {
                // Desktop notifications are T305's job; T303 only wires the reader.
            },
        });
        this._watcher.start();

        console.log(`AgentBar ${this.metadata['version-name']} enabled`);
    }

    _renderView(view) {
        this._icon.icon_name = ICON_BY_INTENT[view.intent] ?? ICON_BY_INTENT.unknown;
        this._label.text = view.label;

        this._indicator.menu.removeAll();
        if (view.sessions.length === 0) {
            this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem('No Claude sessions yet', {reactive: false}));
        } else {
            for (const session of view.sessions) {
                const hint = session.hint ? ` (${session.hint})` : '';
                const stale = session.stale ? ' - stale' : '';
                const text = `${session.projectName}${hint}: ${session.label}${stale} - ${session.message}`;
                this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false}));
            }
        }
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            `AgentBar ${this.metadata['version-name']}`, {reactive: false}));
    }

    _renderUnavailable(label) {
        this._icon.icon_name = ICON_BY_INTENT.unknown;
        this._label.text = label;
        this._indicator.menu.removeAll();
        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(label, {reactive: false}));
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            `AgentBar ${this.metadata['version-name']}`, {reactive: false}));
    }

    disable() {
        this._watcher?.stop();
        this._watcher = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._label = null;
        console.log('AgentBar disabled');
    }
}
