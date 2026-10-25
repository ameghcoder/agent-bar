import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ALERT_CHOICES, ALERT_STATES, TOP_BAR_CONTENTS, alertChoiceFrom, testAlertRequest, topBarContentFrom} from './lib/settings.js';

// T901: AgentBar's settings window, opened from the Extensions app or the
// AgentBar menu. It runs in the Extensions app's process, not in GNOME Shell.
// Later tasks add their own groups; every choice and default comes from
// lib/settings.js.

const REPORT_URL = 'https://github.com/ameghcoder/agent-bar/issues/new/choose';

// What a Test press will do, said back as a toast.
const TEST_TOAST_BY_CHOICE = {
    'banner-and-sound': 'Test alert sent: banner and sound',
    'banner': 'Test alert sent: banner only',
    'sound': 'Test alert sent: sound only',
    'top-bar': 'Top bar only: this state raises no banner or sound',
};

export default class AgentBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = null;
        try {
            settings = this.getSettings();
        } catch (error) {
            console.log(`AgentBar: settings unavailable - ${error.message}`);
        }

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        if (settings) {
            page.add(this._topBarGroup(window, settings));
            page.add(this._alertsGroup(window, settings));
        } else {
            page.add(this._unavailableGroup());
        }
        page.add(this._aboutGroup());
        window.add(page);
    }

    // T902: "Show in top bar".
    _topBarGroup(window, settings) {
        const group = new Adw.PreferencesGroup({title: 'Top bar'});
        group.add(this._choiceRow(window, settings, {
            title: 'Show in top bar',
            key: 'top-bar-content',
            choices: TOP_BAR_CONTENTS,
            read: () => topBarContentFrom(settings),
        }));
        return group;
    }

    // T903: one choice per state. The top bar always shows the true state;
    // these only decide how loudly AgentBar says it.
    _alertsGroup(window, settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Alerts',
            description: 'How AgentBar tells you about each state. Do Not Disturb silences banners and sounds.',
        });
        const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        for (const state of ALERT_STATES) {
            const row = this._choiceRow(window, settings, {
                title: state.label,
                key: state.key,
                choices: ALERT_CHOICES,
                read: () => alertChoiceFrom(settings, state.status),
            });
            // Asks AgentBar in GNOME Shell to raise one test alert for this
            // state, through the same code as a real one.
            const button = new Gtk.Button({label: 'Test', valign: Gtk.Align.CENTER, tooltip_text: `Show a test "${state.label}" alert`});
            button.connect('clicked', () => {
                settings.set_string('test-alert', testAlertRequest(state.status, Date.now()));
                const choice = alertChoiceFrom(settings, state.status);
                const quiet = choice !== 'top-bar' && !notifications.get_boolean('show-banners');
                window.add_toast(new Adw.Toast({title: quiet ? 'Do Not Disturb is on, so the test alert stays silent' : TEST_TOAST_BY_CHOICE[choice]}));
            });
            row.add_suffix(button);
            group.add(row);
        }
        return group;
    }

    // A drop-down bound to one string key. The row and the stored value
    // follow each other, so a change made elsewhere (gsettings, a second
    // window) shows up.
    _choiceRow(window, settings, {title, key, choices, read}) {
        const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices.map(choice => choice.label))});
        const showStored = () => {
            row.selected = choices.findIndex(choice => choice.id === read());
        };
        showStored();
        row.connect('notify::selected', () => {
            const choice = choices[row.selected];
            if (choice && choice.id !== read())
                settings.set_string(key, choice.id);
        });
        const changedId = settings.connect(`changed::${key}`, showStored);
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
        return row;
    }

    _unavailableGroup() {
        return new Adw.PreferencesGroup({
            title: 'Settings unavailable',
            description: 'AgentBar\'s settings file is not installed. Reinstall the agentbar package, then log out and back in. AgentBar keeps working with its default settings.',
        });
    }

    _aboutGroup() {
        const group = new Adw.PreferencesGroup({title: 'About'});
        group.add(new Adw.ActionRow({title: 'Version', subtitle: `AgentBar ${this.metadata['version-name'] ?? ''}`.trim()}));
        group.add(this._linkRow('Source code', 'GitHub', this.metadata.url));
        group.add(this._linkRow('Report a problem', 'Open a report', REPORT_URL));
        group.add(new Adw.ActionRow({
            title: 'Check your setup',
            subtitle: 'Run "agentbar doctor" in a terminal',
            subtitle_selectable: true,
        }));
        return group;
    }

    _linkRow(title, label, uri) {
        const row = new Adw.ActionRow({title});
        row.add_suffix(new Gtk.LinkButton({label, uri, valign: Gtk.Align.CENTER}));
        return row;
    }
}
