/** Context must fall strictly below this percentage to re-arm, even for low thresholds. */
export const rearmBelow = (above: number) => above - Math.min(10, above / 2)
