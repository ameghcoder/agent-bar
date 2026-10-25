import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ancestorsOf, pickWindow} from './lib/focus.js';
import {SPARK_FRAME_COUNT, SPARK_FRAME_MS, iconMotion, sparkAllowed, sparkFrame} from './lib/icon-animation.js';
import {notificationsFor} from './lib/presentation.js';
import {alertChoiceFrom, iconAnimationFrom, planAlerts, testAlertStatus, topBarContentFrom, topBarParts} from './lib/settings.js';
import {installedVersion, needsRelogin} from './lib/upgrade.js';
import {StateWatcher, readProcStat} from './lib/state-reader.js';

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

// T902: with the icon hidden, the title takes over the same two colours, so
// "needs you" stays visible in Text only mode.
const LABEL_STYLE_CLASS_BY_INTENT = {
    attention: 'agentbar-label-attention',
    error: 'agentbar-label-error',
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

// T904: the animated spark loops while Claude works, so it is a GLib timer
// swapping SVG frames (lib/icon-animation.js), never an endless ease(): the
// constraint above applies to transitions, and a frame swap is one redraw of
// one small icon. It stops whenever it cannot be seen. "Turn complete" pops
// once and "Failed" shakes once, both finite.
const POP_START_SCALE = 0.6;
const POP_MS = 400;
const SHAKE_PX = 3;
const SHAKE_HALF_MS = 60;
const SHAKE_HALF_COUNT = 6;

const DOCTOR_COMMAND = 'agentbar doctor';
// dpkg replaces many files in a row; check the version once it has settled.
const UPGRADE_CHECK_DELAY_MS = 2000;

// presentation.ts decides urgency (ADR 0004: permission gets the strongest
// tier without repeatedly stealing focus); this is only the GNOME enum lookup.
// GNOME's LOW never shows a banner, and a notification's sound plays only with
// its banner (GNOME Shell 50 messageTray.js). Whether a banner shows is the
// user's per-state choice (T903), so 'low' maps to NORMAL; "Top bar only" is
// how a user asks for no banner.
const SHELL_URGENCY = {
    critical: MessageTray.Urgency.CRITICAL,
    high: MessageTray.Urgency.HIGH,
    normal: MessageTray.Urgency.NORMAL,
    low: MessageTray.Urgency.NORMAL,
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
    // ADR 0008: a stale session whose process still runs is a long quiet task,
    // not a closed terminal.
    const stale = session.stale ? (session.alive ? ' · stale · Claude open' : ' · stale') : '';
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
        // sessionId -> project name, for matching a window title (T403).
        this._rowProjects = new Map();
        this._placeholder = new PopupMenu.PopupMenuItem('Reading state...', {reactive: false});
        this._indicator.menu.addMenuItem(this._placeholder);
        this._sessionsSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._sessionsSection);
        this._buildFooter();
        // T403: which rows can bring a window forward is decided each time the
        // menu opens, because windows open and close while it is shut.
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._syncClickableRows();
        });

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
        this._animationsChangedId = this._stSettings.connect('notify::enable-animations', () => this._restartAnimation());
        this._motion = 'none';
        this._sparkTimer = 0;
        this._sparkTick = 0;
        this._sparkIcons = Array.from({length: SPARK_FRAME_COUNT}, (_, index) =>
            Gio.FileIcon.new(this.dir.get_child('icons').get_child(`agentbar-spark-${index}-symbolic.svg`)));
        // The spark pauses while a fullscreen window covers the panel and
        // while the screen is locked.
        this._fullscreenChangedId = global.display.connect('in-fullscreen-changed', () => this._syncSpark());
        this._sessionModeChangedId = Main.sessionMode.connect('updated', () => this._syncSpark());

        // T901: settings are the extension's own. A missing or broken schema
        // leaves every setting at its default instead of failing enable().
        try {
            this._settings = this.getSettings();
        } catch (error) {
            console.log(`AgentBar: settings unavailable, using defaults - ${error.message}`);
            this._settings = null;
        }
        this._settingsChangedId = this._settings?.connect('changed::top-bar-content', () => this._applyTopBarContent()) ?? 0;
        this._applyTopBarContent();
        // T903: GNOME's Do Not Disturb switch, for alerts that play a sound
        // without a banner. Banners carry their own sound, which GNOME only
        // plays when it actually shows the banner.
        this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._lastSoundAt = -Infinity;
        this._testAlertChangedId = this._settings?.connect('changed::test-alert', () => this._runTestAlert()) ?? 0;
        this._iconAnimationChangedId = this._settings?.connect('changed::icon-animation', () => this._restartAnimation()) ?? 0;

        // T905: when the installed files change version (an apt upgrade),
        // ask for a logout. Only the extension's own folder is watched; no
        // network is involved.
        this._notifiedVersion = null;
        this._upgradeCheckSource = 0;
        this._metadataMonitor = this.dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._metadataMonitor.connect('changed', () => this._scheduleUpgradeCheck());
        this._checkUpgrade();

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
        // T905: shown only after an upgrade, until the next login.
        this._reloginItem = new PopupMenu.PopupMenuItem('Log out to finish updating AgentBar');
        this._reloginItem.connect('activate', () => this._logOut());
        this._reloginItem.visible = false;
        this._indicator.menu.addMenuItem(this._reloginItem);
        // Text comes from presentation.js (view.health); no state yet reads as
        // unavailable until the first view or placeholder arrives.
        this._healthItem = new PopupMenu.PopupMenuItem('State unavailable', {reactive: false});
        this._indicator.menu.addMenuItem(this._healthItem);
        const doctorItem = new PopupMenu.PopupMenuItem(`Copy "${DOCTOR_COMMAND}"`);
        doctorItem.connect('activate', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, DOCTOR_COMMAND);
        });
        this._indicator.menu.addMenuItem(doctorItem);
        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(settingsItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            `AgentBar ${this.metadata['version-name']}`, {reactive: false}));
    }

    _renderView(view) {
        this._lastView = view;
        // While the spark runs it owns the icon; _stopAnimation puts the
        // state's icon back.
        if (!this._sparkTimer)
            this._icon.icon_name = ICON_BY_INTENT[view.intent] ?? ICON_BY_INTENT.unknown;
        this._icon.style_class = `system-status-icon ${STYLE_CLASS_BY_INTENT[view.intent] ?? ''}`.trim();
        // presentation.js builds the whole text ("project - State +N"); this
        // only displays it.
        this._label.text = view.title;
        // Screen readers hear the whole title even when only the icon shows.
        this._indicator.accessible_name = `AgentBar: ${view.title}`;
        this._syncLabelStyle();
        this._healthItem.label.text = view.health;
        this._syncSessionRows(view.sessions);
        this._applyAnimation(view);
    }

    // T902: which of the icon and the title the top bar shows, applied live.
    _applyTopBarContent() {
        const parts = topBarParts(topBarContentFrom(this._settings));
        this._icon.visible = parts.icon;
        this._label.visible = parts.label;
        this._syncLabelStyle();
        // Motion only runs on a visible icon; restart it for the new layout.
        this._restartAnimation();
    }

    _restartAnimation() {
        this._stopAnimation();
        this._animationKey = '';
        if (this._lastView)
            this._applyAnimation(this._lastView);
    }

    _syncLabelStyle() {
        const intent = this._icon.visible ? undefined : this._lastView?.intent;
        this._label.style_class = `agentbar-indicator-label ${LABEL_STYLE_CLASS_BY_INTENT[intent] ?? ''}`.trim();
    }

    _animationsEnabled() {
        // GNOME's own reduce-motion setting, and a fullscreen window on the
        // primary monitor hides the panel anyway.
        return this._stSettings.enable_animations
            && !Main.layoutManager.primaryMonitor?.inFullscreen;
    }

    // Starts, keeps, or stops the motion for this view (T904: iconMotion
    // picks it from the state and the user's "Icon" choice). The key is the
    // motion, intent, status, and leading session - deliberately not the
    // title, whose time-ago text changes every minute. A new project or state
    // moves again; an identical re-read (every state write, every 30 s) does
    // not restart it.
    _applyAnimation(view) {
        const motion = iconMotion(view, iconAnimationFrom(this._settings));
        const key = motion === 'none' ? '' : `${motion}|${view.intent}|${view.status}|${view.leaderId}`;
        if (key === this._animationKey)
            return;
        this._stopAnimation();
        this._animationKey = key;
        this._motion = motion;
        if (motion === 'spark') {
            this._syncSpark();
        } else if (motion === 'pop') {
            this._popOnce();
        } else if (motion === 'shake') {
            this._shakeOnce();
        } else if (motion === 'pulse') {
            const pulse = PULSE_BY_INTENT[view.intent];
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
    }

    // Starts or stops the spark's frame timer to match whether it can be
    // seen. Called when the motion, fullscreen, lock, or icon visibility
    // changes.
    _syncSpark() {
        if (!this._icon)
            return;
        const wanted = this._motion === 'spark' && sparkAllowed({
            animationsEnabled: this._stSettings.enable_animations,
            fullscreen: Boolean(Main.layoutManager.primaryMonitor?.inFullscreen),
            locked: Main.sessionMode.isLocked,
            iconVisible: this._icon.visible,
        });
        if (wanted && !this._sparkTimer) {
            this._sparkTick = 0;
            this._showSparkFrame();
            this._sparkTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPARK_FRAME_MS, () => {
                this._showSparkFrame();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._sparkTimer) {
            this._stopSpark();
        }
    }

    _showSparkFrame() {
        this._icon.gicon = this._sparkIcons[sparkFrame(this._sparkTick)];
        this._sparkTick += 1;
    }

    _stopSpark() {
        GLib.Source.remove(this._sparkTimer);
        this._sparkTimer = 0;
        this._icon.icon_name = ICON_BY_INTENT[this._lastView?.intent] ?? ICON_BY_INTENT.quiet;
    }

    // "Turn complete": the icon grows into place once.
    _popOnce() {
        if (!this._icon.visible || !this._animationsEnabled())
            return;
        this._icon.set_pivot_point(0.5, 0.5);
        this._icon.set_scale(POP_START_SCALE, POP_START_SCALE);
        this._icon.ease({
            scale_x: 1,
            scale_y: 1,
            duration: POP_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    // "Failed": three small nudges, then rest.
    _shakeOnce() {
        if (!this._icon.visible || !this._animationsEnabled())
            return;
        this._icon.translation_x = 0;
        this._icon.ease({
            translation_x: SHAKE_PX,
            duration: SHAKE_HALF_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            repeatCount: SHAKE_HALF_COUNT - 1,
            autoReverse: true,
            onComplete: () => {
                if (this._icon)
                    this._icon.translation_x = 0;
            },
        });
    }

    _pulseOnce(roundTrips) {
        if (!this._icon || !this._icon.visible || !this._animationsEnabled())
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
        if (this._sparkTimer)
            this._stopSpark();
        this._motion = 'none';
        if (this._icon) {
            this._icon.remove_all_transitions();
            this._icon.opacity = 255;
            this._icon.set_scale(1, 1);
            this._icon.translation_x = 0;
        }
    }

    // Each NotificationView is already deduped and decided by presentation.ts
    // (notificationsFor): one per meaningful transition, never on startup
    // replay, never for a rewrite that changed nothing. T903: the user's
    // per-state choice decides banner and sound (planAlerts, lib/settings.js);
    // this only turns the plan into GNOME calls.
    _showNotifications(notifications) {
        const now = GLib.get_monotonic_time() / 1000;
        const {alerts, lastSoundAt} = planAlerts(notifications, status => alertChoiceFrom(this._settings, status),
            {lastSoundAt: this._lastSoundAt, now});
        this._lastSoundAt = lastSoundAt;
        this._raiseAlerts(alerts);
    }

    // A Test button in the settings window: one alert for that state through
    // the same rules and code as a real one, so it proves the user's choice,
    // the sound, and Do Not Disturb. The notification comes from
    // notificationsFor itself (title, icon, urgency); only the body says it
    // is a test. It ignores the gap between sounds and does not move it.
    _runTestAlert() {
        const status = testAlertStatus(this._settings?.get_string('test-alert'));
        if (!status)
            return;
        const session = state => ({sessionId: 'agentbar-test', status: state, ended: false, projectName: 'Test alert from AgentBar settings'});
        const notifications = notificationsFor({sessions: [session('running')]}, {sessions: [session(status)]});
        const {alerts} = planAlerts(notifications, state => alertChoiceFrom(this._settings, state), {lastSoundAt: -Infinity, now: 0});
        this._raiseAlerts(alerts);
    }

    _raiseAlerts(alerts) {
        for (const {notification, banner, sound} of alerts) {
            if (banner) {
                this._notificationSource.addNotification(new MessageTray.Notification({
                    source: this._notificationSource,
                    title: notification.title,
                    body: notification.body,
                    iconName: ICON_BY_INTENT[notification.intent] ?? ICON_BY_INTENT.unknown,
                    urgency: SHELL_URGENCY[notification.urgency] ?? MessageTray.Urgency.NORMAL,
                    sound: sound ? new MessageTray.Sound(null, sound) : null,
                }));
            } else if (sound && !this._doNotDisturb()) {
                global.display.get_sound_player().play_from_theme(sound, notification.title, null);
            }
        }
    }

    _scheduleUpgradeCheck() {
        if (this._upgradeCheckSource)
            GLib.Source.remove(this._upgradeCheckSource);
        this._upgradeCheckSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPGRADE_CHECK_DELAY_MS, () => {
            this._upgradeCheckSource = 0;
            this._checkUpgrade();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Compares the running version with the installed metadata.json. The
    // menu row stays until the next login; the notification is raised once
    // per installed version.
    _checkUpgrade() {
        let text = null;
        try {
            const [, bytes] = this.dir.get_child('metadata.json').load_contents(null);
            text = new TextDecoder().decode(bytes);
        } catch {
            text = null;
        }
        const relogin = needsRelogin(this.metadata['version-name'], text);
        this._reloginItem.visible = relogin;
        const installed = installedVersion(text);
        if (!relogin || installed === this._notifiedVersion)
            return;
        this._notifiedVersion = installed;
        console.log(`AgentBar: ${installed} is installed, ${this.metadata['version-name']} is running; asking for a logout`);
        const notification = new MessageTray.Notification({
            source: this._notificationSource,
            title: 'AgentBar was updated',
            body: 'Log out and back in to finish updating.',
            iconName: 'system-software-update-symbolic',
            urgency: MessageTray.Urgency.NORMAL,
        });
        notification.addAction('Log Out', () => this._logOut());
        this._notificationSource.addNotification(notification);
    }

    // Opens GNOME's normal logout confirmation; the user can still cancel.
    _logOut() {
        try {
            SystemActions.getDefault().activateLogout();
        } catch (error) {
            console.log(`AgentBar: cannot open the logout dialog - ${error.message}`);
        }
    }

    _doNotDisturb() {
        return !this._notificationSettings.get_boolean('show-banners');
    }

    _renderPlaceholder(text, iconName, labelText) {
        this._lastView = null;
        this._animationKey = '';
        this._stopAnimation();
        this._icon.icon_name = iconName;
        this._icon.style_class = 'system-status-icon';
        this._label.text = labelText;
        this._indicator.accessible_name = `AgentBar: ${labelText}`;
        this._syncLabelStyle();
        this._healthItem.label.text = 'State unavailable';
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
                // Built activatable but left insensitive until a window is
                // found: the inactive style keeps today's look either way.
                item = new PopupMenu.PopupImageMenuItem(sessionRowText(session), ICON_BY_INTENT[session.intent] ?? ICON_BY_INTENT.unknown);
                item.add_style_class_name('popup-inactive-menu-item');
                item.setSensitive(false);
                ellipsizeRow(item);
                const sessionId = session.sessionId;
                item.connect('activate', () => this._focusSession(sessionId));
                this._rows.set(sessionId, item);
                this._sessionsSection.addMenuItem(item);
            }
            this._rowProjects.set(session.sessionId, session.projectName);
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
                this._rowProjects.delete(sessionId);
            }
        }
    }

    // The window running a session's agent, or null. Reads only
    // /proc/<pid>/stat up the process chain; window titles are matched here
    // and never logged or stored.
    _focusTarget(sessionId) {
        const agent = this._watcher?.processFor(sessionId);
        if (!agent)
            return null;
        const windows = global.get_window_actors()
            .map(actor => actor.get_meta_window())
            .filter(window => window && window.get_window_type() === Meta.WindowType.NORMAL && !window.is_skip_taskbar())
            .map(window => ({pid: window.get_pid(), title: window.get_title() ?? '', window}));
        const projectName = this._rowProjects.get(sessionId) ?? '';
        return pickWindow(ancestorsOf(agent.pid, readProcStat), windows, projectName)?.window ?? null;
    }

    _syncClickableRows() {
        for (const [sessionId, item] of this._rows)
            item.setSensitive(this._focusTarget(sessionId) !== null);
    }

    // Looked up again at click time: the window found when the menu opened
    // may have closed since.
    _focusSession(sessionId) {
        const window = this._focusTarget(sessionId);
        if (window)
            Main.activateWindow(window);
    }

    disable() {
        this._watcher?.stop();
        this._watcher = null;
        this._metadataMonitor?.cancel();
        this._metadataMonitor = null;
        if (this._upgradeCheckSource) {
            GLib.Source.remove(this._upgradeCheckSource);
            this._upgradeCheckSource = 0;
        }
        this._reloginItem = null;
        this._stopAnimation();
        if (this._fullscreenChangedId) {
            global.display.disconnect(this._fullscreenChangedId);
            this._fullscreenChangedId = 0;
        }
        if (this._sessionModeChangedId) {
            Main.sessionMode.disconnect(this._sessionModeChangedId);
            this._sessionModeChangedId = 0;
        }
        this._sparkIcons = null;
        if (this._animationsChangedId) {
            this._stSettings.disconnect(this._animationsChangedId);
            this._animationsChangedId = 0;
        }
        this._stSettings = null;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._testAlertChangedId) {
            this._settings.disconnect(this._testAlertChangedId);
            this._testAlertChangedId = 0;
        }
        if (this._iconAnimationChangedId) {
            this._settings.disconnect(this._iconAnimationChangedId);
            this._iconAnimationChangedId = 0;
        }
        this._settings = null;
        this._notificationSettings = null;
        this._lastView = null;
        this._rows?.clear();
        this._rowProjects?.clear();
        this._notificationSource?.destroy();
        this._notificationSource = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
        this._label = null;
        this._sessionsSection = null;
        this._placeholder = null;
        this._healthItem = null;
        console.log('AgentBar disabled');
    }
}
