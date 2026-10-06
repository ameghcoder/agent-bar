import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {StateWatcher} from './lib/state-reader.js';

// Rendering only reads `intent` (T302's fixed vocabulary), never `status`, so
// a new status can never appear in the top bar or a row without an explicit
// label and icon.
const ICON_BY_INTENT = {
    quiet: 'utilities-terminal-symbolic',
    active: 'media-playback-start-symbolic',
    attention: 'dialog-password-symbolic',
    complete: 'object-select-symbolic',
    error: 'dialog-error-symbolic',
    unknown: 'dialog-warning-symbolic',
};

// Restrained: only the two intents that need a developer's attention get a
// colour; everything else keeps the theme's default symbolic colour.
const STYLE_CLASS_BY_INTENT = {
    attention: 'agentbar-icon-attention',
    error: 'agentbar-icon-error',
};

// Which intents move, and how. Only brief, finite pulses: while any transition
// with a duration runs, Clutter's ease() holds global.begin_work() and
// compositor.disable_unredirect() (checked in GNOME Shell 50.1's
// environment.js), so an endless pulse would keep fullscreen windows off
// direct scanout for as long as a session runs. A "round trip" is dim and back.
// `everySeconds` repeats the pulse from a timer that disable() removes.
const PULSE_BY_INTENT = {
    active: {roundTrips: 1, everySeconds: 8},
    attention: {roundTrips: 3, everySeconds: 0},
};
const PULSE_LOW_OPACITY = 90;
const PULSE_HALF_MS = 700;

const DOCTOR_COMMAND = 'agentbar doctor';

// presentation.ts decides urgency (ADR 0004: permission gets the strongest
// tier without repeatedly stealing focus); this is only the GNOME enum lookup.
const SHELL_URGENCY = {
    critical: MessageTray.Urgency.CRITICAL,
    high: MessageTray.Urgency.HIGH,
    normal: MessageTray.Urgency.NORMAL,
    low: MessageTray.Urgency.LOW,
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

function sessionRowText(session) {
    const hint = session.hint ? ` (${session.hint})` : '';
    const stale = session.stale ? ' · stale' : '';
    return `${session.projectName}${hint} · ${session.label}${stale} · ${session.relative}`;
}

function ellipsizeRow(item) {
    item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    item.label.x_expand = true;
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

        // Session rows are kept as a stable sessionId -> actor map and only
        // ever moved/updated in place; the placeholder is a sibling item, not
        // one of the section's rows, so the section's positions are always
        // plain 0-based session indices - no offset to get wrong. The footer
        // is built once, since it never depends on state (see
        // _syncSessionRows and T304's "keep rows stable during refresh to
        // avoid visible layout jumping").
        this._rows = new Map();
        this._placeholder = new PopupMenu.PopupMenuItem('Reading state...', {reactive: false});
        this._indicator.menu.addMenuItem(this._placeholder);
        this._sessionsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._sessionsSection);
        this._buildFooter();

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // One long-lived source, like any well-behaved notifying app; GNOME
        // shows its title ("AgentBar") above each notification's own title
        // and body, so those two fields don't need to repeat it.
        this._notificationSource = new MessageTray.Source({
            title: 'AgentBar',
            iconName: ICON_BY_INTENT.quiet,
        });
        Main.messageTray.add(this._notificationSource);

        // Animation state. `_animationKey` stops a routine re-read from
        // restarting a pulse that is already running for the same state.
        this._animationKey = '';
        this._pulseTimer = 0;
        this._lastView = null;
        this._stSettings = St.Settings.get();
        this._animationsChangedId = this._stSettings.connect('notify::enable-animations', () => {
            this._stopAnimation();
            this._animationKey = '';
            if (this._lastView) this._applyAnimation(this._lastView);
        });

        this._watcher = new StateWatcher(statePath(), {
            onView: (view) => this._renderView(view),
            onUnavailable: (message) => {
                // The message comes from parseSnapshot or a Gio I/O error, both of
                // which are already safe diagnostic text - never raw session data.
                console.log(`AgentBar: state unavailable - ${message}`);
                this._renderPlaceholder('Status unavailable', ICON_BY_INTENT.unknown, 'AgentBar - State unavailable');
            },
            onNotifications: (notifications) => this._showNotifications(notifications),
        });
        this._watcher.start();

        console.log(`AgentBar ${this.metadata['version-name']} enabled`);
    }

    _buildFooter() {
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const doctorItem = new PopupMenu.PopupMenuItem(`Copy "${DOCTOR_COMMAND}"`);
        doctorItem.connect('activate', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, DOCTOR_COMMAND);
        });
        this._indicator.menu.addMenuItem(doctorItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            `AgentBar ${this.metadata['version-name']}`, {reactive: false}));
    }

    _renderView(view) {
        this._lastView = view;
        this._icon.icon_name = ICON_BY_INTENT[view.intent] ?? ICON_BY_INTENT.unknown;
        this._icon.style_class = `system-status-icon ${STYLE_CLASS_BY_INTENT[view.intent] ?? ''}`.trim();
        // presentation.js builds the whole text ("project - State +N"); this
        // only displays it.
        this._label.text = view.title;
        this._syncSessionRows(view.sessions);
        this._applyAnimation(view);
    }

    _animationsEnabled() {
        // GNOME's own reduce-motion setting, and a fullscreen window on the
        // primary monitor hides the panel anyway.
        return this._stSettings.enable_animations
            && !Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    // Starts, keeps, or stops the pulse for this view. The key is the intent,
    // status, and leading session - deliberately not the title, whose time-ago
    // text changes every minute. A new project or state pulses again; an
    // identical re-read (every state write, every 30 s) does not restart it.
    _applyAnimation(view) {
        const pulse = PULSE_BY_INTENT[view.intent];
        const key = pulse ? `${view.intent}|${view.status}|${view.leaderId}` : '';
        if (key === this._animationKey)
            return;
        this._stopAnimation();
        this._animationKey = key;
        if (!pulse)
            return;
        this._pulseOnce(pulse.roundTrips);
        if (pulse.everySeconds > 0) {
            this._pulseTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, pulse.everySeconds, () => {
                this._pulseOnce(pulse.roundTrips);
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _pulseOnce(roundTrips) {
        if (!this._icon || !this._animationsEnabled())
            return;
        this._icon.remove_all_transitions();
        this._icon.opacity = 255;
        this._icon.ease({
            opacity: PULSE_LOW_OPACITY,
            duration: PULSE_HALF_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            // repeatCount excludes the first iteration; each round trip is two.
            repeatCount: roundTrips * 2 - 1,
            autoReverse: true,
            onComplete: () => {
                if (this._icon)
                    this._icon.opacity = 255;
            },
        });
    }

    _stopAnimation() {
        if (this._pulseTimer) {
            GLib.Source.remove(this._pulseTimer);
            this._pulseTimer = 0;
        }
        if (this._icon) {
            this._icon.remove_all_transitions();
            this._icon.opacity = 255;
        }
    }

    // Each NotificationView is already deduped and decided by presentation.ts
    // (notificationsFor): one per meaningful transition, never on startup
    // replay, never for a rewrite that changed nothing. This only turns each
    // one into a real GNOME notification.
    _showNotifications(notifications) {
        for (const notification of notifications) {
            this._notificationSource.addNotification(new MessageTray.Notification({
                source: this._notificationSource,
                title: notification.title,
                body: notification.body,
                iconName: ICON_BY_INTENT[notification.intent] ?? ICON_BY_INTENT.unknown,
                urgency: SHELL_URGENCY[notification.urgency] ?? MessageTray.Urgency.NORMAL,
            }));
        }
    }

    _renderPlaceholder(text, iconName, labelText) {
        this._lastView = null;
        this._animationKey = '';
        this._stopAnimation();
        this._icon.icon_name = iconName;
        this._icon.style_class = 'system-status-icon';
        this._label.text = labelText;
        this._syncSessionRows([]);
        this._placeholder.label.text = text;
    }

    // Only ever creates a row for a sessionId not seen before, updates an
    // existing row's icon/text/colour in place, moves rows to match the
    // view's order via moveMenuItem (never removes and re-adds them), and
    // destroys rows for sessions that disappeared. Hover state, hidden focus,
    // and the menu's scroll position all survive a routine re-render because
    // no unrelated actor is ever recreated.
    _syncSessionRows(sessions) {
        if (sessions.length === 0) {
            this._placeholder.label.text = 'No Claude sessions yet';
            this._placeholder.visible = true;
        } else {
            this._placeholder.visible = false;
        }

        const seen = new Set();
        sessions.forEach((session, index) => {
            seen.add(session.sessionId);
            let item = this._rows.get(session.sessionId);
            if (!item) {
                item = new PopupMenu.PopupImageMenuItem(sessionRowText(session), ICON_BY_INTENT[session.intent], {reactive: false});
                ellipsizeRow(item);
                this._rows.set(session.sessionId, item);
                this._sessionsSection.addMenuItem(item);
            }
            item.label.text = sessionRowText(session);
            item.setIcon(ICON_BY_INTENT[session.intent] ?? ICON_BY_INTENT.unknown);
            for (const styleClass of Object.values(STYLE_CLASS_BY_INTENT)) item.remove_style_class_name(styleClass);
            const rowStyleClass = STYLE_CLASS_BY_INTENT[session.intent];
            if (rowStyleClass) item.add_style_class_name(rowStyleClass);
            this._sessionsSection.moveMenuItem(item, index);
        });

        for (const [sessionId, item] of this._rows) {
            if (!seen.has(sessionId)) {
                item.destroy();
                this._rows.delete(sessionId);
            }
        }
    }

    disable() {
        this._watcher?.stop();
        this._watcher = null;
        this._stopAnimation();
        if (this._animationsChangedId) {
            this._stSettings.disconnect(this._animationsChangedId);
            this._animationsChangedId = 0;
        }
        this._stSettings = null;
        this._lastView = null;
        this._rows.clear();
        this._notificationSource?.destroy();
        this._notificationSource = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._label = null;
        this._sessionsSection = null;
        this._placeholder = null;
        console.log('AgentBar disabled');
    }
}
