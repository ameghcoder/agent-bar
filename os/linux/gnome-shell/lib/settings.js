// AgentBar's settings choices and defaults, shared by extension.js (GNOME
// Shell) and prefs.js (the Extensions app). Pure data and plain functions with
// no imports, so Node tests them directly (test/settings.test.mjs). The schema
// in os/linux/schemas/ must declare the same choices and defaults.
//
// Settings belong to the GNOME extension only: they never enter the state
// contract, and a missing or broken setting always falls back to its default.

export const SCHEMA_ID = 'org.gnome.shell.extensions.agentbar';

// T902: what the top bar shows. Listed in the order the settings window
// offers them.
export const TOP_BAR_CONTENTS = [
    {id: 'icon-and-text', label: 'Icon and text'},
    {id: 'icon', label: 'Icon only'},
    {id: 'text', label: 'Text only'},
];
export const DEFAULT_TOP_BAR_CONTENT = 'icon-and-text';

// `settings` is a Gio.Settings, or null when the schema is not installed.
export function topBarContentFrom(settings) {
    try {
        const value = settings?.get_string('top-bar-content');
        return TOP_BAR_CONTENTS.some(choice => choice.id === value) ? value : DEFAULT_TOP_BAR_CONTENT;
    } catch {
        return DEFAULT_TOP_BAR_CONTENT;
    }
}

// Which parts of the indicator are visible. Anything unrecognised shows both,
// so the indicator can never become empty.
export function topBarParts(content) {
    return {icon: content !== 'text', label: content !== 'icon'};
}
