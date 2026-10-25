// T904: which motion the top-bar icon makes. Pure functions with no imports,
// so Node tests every rule directly (test/icon-animation.test.mjs).
//
// Motions: 'spark' (a looping frame swap while Claude works), 'pulse' (the
// short opacity pulse from 0.2.0), 'pop' and 'shake' (play once, then rest),
// or 'none'. Nothing here may read as progress, and a stale session never
// moves, so a stuck session never looks busy.

export const SPARK_FRAME_COUNT = 6;
export const SPARK_FRAME_MS = 120;

// `animation` is the user's "Icon" choice: 'spark', 'pulse', or 'still'.
export function iconMotion(view, animation) {
    if (!view || view.stale || animation === 'still')
        return 'none';
    if (animation === 'pulse')
        return view.intent === 'active' || view.intent === 'attention' ? 'pulse' : 'none';
    switch (view.intent) {
    case 'active':
        return 'spark';
    case 'attention':
        return 'pulse';
    case 'complete':
        return 'pop';
    case 'error':
        return 'shake';
    default:
        return 'none';
    }
}

// Frame index for a tick: up through the frames and back down, so the spark
// grows and shrinks without jumping from the largest frame to the smallest.
export function sparkFrame(tick) {
    const period = 2 * (SPARK_FRAME_COUNT - 1);
    const position = tick % period;
    return position < SPARK_FRAME_COUNT ? position : period - position;
}

// The spark costs a wake-up per frame, so it runs only while it can be seen
// and motion is welcome.
export function sparkAllowed({animationsEnabled, fullscreen, locked, iconVisible}) {
    return animationsEnabled && !fullscreen && !locked && iconVisible;
}
