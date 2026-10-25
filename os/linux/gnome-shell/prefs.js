import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {TOP_BAR_CONTENTS, topBarContentFrom} from './lib/settings.js';

// T901: AgentBar's settings window, opened from the Extensions app or the
// AgentBar menu. It runs in the Extensions app's process, not in GNOME Shell.
// Later tasks add their own groups; every choice and default comes from
// lib/settings.js.

const REPORT_URL = 'https://github.com/ameghcoder/agent-bar/issues/new/choose';

export default class AgentBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        let settings = null;
        try {
            settings = this.getSettings();
        } catch (error) {
            console.log(`AgentBar: settings unavailable - ${error.message}`);
        }

        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        page.add(settings ? this._topBarGroup(window, settings) : this._unavailableGroup());
        page.add(this._aboutGroup());
        window.add(page);
    }

    // T902: "Show in top bar". The row and the stored value follow each
    // other, so a change made elsewhere (gsettings, a second window) shows up.
    _topBarGroup(window, settings) {
        const group = new Adw.PreferencesGroup({title: 'Top bar'});
        const row = new Adw.ComboRow({
            title: 'Show in top bar',
            model: Gtk.StringList.new(TOP_BAR_CONTENTS.map(choice => choice.label)),
        });
        const showStored = () => {
            row.selected = TOP_BAR_CONTENTS.findIndex(choice => choice.id === topBarContentFrom(settings));
        };
        showStored();
        row.connect('notify::selected', () => {
            const choice = TOP_BAR_CONTENTS[row.selected];
            if (choice && choice.id !== topBarContentFrom(settings))
                settings.set_string('top-bar-content', choice.id);
        });
        const changedId = settings.connect('changed::top-bar-content', showStored);
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
        group.add(row);
        return group;
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
