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

// T903: alerts per state. One choice per notifying state decides whether its
// banner shows and whether its sound plays. The top bar and the menu always
// show the true state whatever is chosen here.
export const ALERT_CHOICES = [
    {id: 'banner-and-sound', label: 'Banner and sound'},
    {id: 'banner', label: 'Banner only'},
    {id: 'sound', label: 'Sound only'},
    {id: 'top-bar', label: 'Top bar only'},
];

// Sounds are names from the freedesktop sound theme, present in Ubuntu's Yaru
// theme too, so nothing is bundled and each state sounds different.
export const ALERT_STATES = [
    {status: 'permission_required', key: 'alert-permission', label: 'Permission needed', default: 'banner-and-sound', sound: 'dialog-warning'},
    {status: 'waiting', key: 'alert-waiting', label: 'Waiting for you', default: 'banner-and-sound', sound: 'message-new-instant'},
    {status: 'failed', key: 'alert-failed', label: 'Failed', default: 'banner-and-sound', sound: 'dialog-error'},
    {status: 'completed', key: 'alert-complete', label: 'Turn complete', default: 'banner', sound: 'complete'},
];

// A state AgentBar does not know (a newer core) still shows its banner,
// silently: never hide an alert because of a missing setting.
const UNKNOWN_STATE_CHOICE = 'banner';

export function alertChoiceFrom(settings, status) {
    const state = ALERT_STATES.find(entry => entry.status === status);
    if (!state)
        return UNKNOWN_STATE_CHOICE;
    try {
        const value = settings?.get_string(state.key);
        return ALERT_CHOICES.some(choice => choice.id === value) ? value : state.default;
    } catch {
        return state.default;
    }
}

const URGENCY_RANK = {critical: 0, high: 1, normal: 2, low: 3};
// Alerts closer together than this share one sound.
export const SOUND_GAP_MS = 2000;

// Turns a batch of notifications (already deduplicated by presentation.ts)
// into what to raise: a banner or not, and at most one sound per batch, for
// the most urgent notification that wants one, never within SOUND_GAP_MS of
// the previous sound. `choiceFor(status)` returns an ALERT_CHOICES id.
export function planAlerts(notifications, choiceFor, {lastSoundAt, now}) {
    const plans = notifications.map(notification => {
        const choice = choiceFor(notification.status);
        return {
            notification,
            banner: choice === 'banner-and-sound' || choice === 'banner',
            wantsSound: choice === 'banner-and-sound' || choice === 'sound',
        };
    });
    let loudest = null;
    if (now - lastSoundAt >= SOUND_GAP_MS) {
        for (const plan of plans) {
            if (plan.wantsSound && (!loudest || rank(plan) < rank(loudest)))
                loudest = plan;
        }
    }
    return {
        alerts: plans.map(plan => ({
            notification: plan.notification,
            banner: plan.banner,
            sound: plan === loudest ? soundFor(plan.notification.status) : null,
        })),
        lastSoundAt: loudest ? now : lastSoundAt,
    };
}

function rank(plan) {
    return URGENCY_RANK[plan.notification.urgency] ?? 4;
}

function soundFor(status) {
    return ALERT_STATES.find(state => state.status === status)?.sound ?? null;
}

// Which parts of the indicator are visible. Anything unrecognised shows both,
// so the indicator can never become empty.
export function topBarParts(content) {
    return {icon: content !== 'text', label: content !== 'icon'};
}
