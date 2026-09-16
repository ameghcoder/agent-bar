import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export default class AgentBarExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            style_class: 'system-status-icon',
        }));
        box.add_child(new St.Label({
            text: 'AgentBar',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'agentbar-indicator-label',
        }));
        this._indicator.add_child(box);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem('No Claude sessions yet', {reactive: false}));
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._indicator.menu.addMenuItem(new PopupMenu.PopupMenuItem(
            `AgentBar ${this.metadata['version-name']}`, {reactive: false}));

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        console.log(`AgentBar ${this.metadata['version-name']} enabled`);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        console.log('AgentBar disabled');
    }
}
