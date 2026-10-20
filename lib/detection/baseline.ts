/** Plan §6.1 calibration: the baseline is the average leaf cover of the healthy calibration photos. */
export function calibrationBaseline(coverPcts: number[]): number {
  if (coverPcts.length === 0) throw new Error("At least one calibration photo is required");
  return coverPcts.reduce((a, b) => a + b, 0) / coverPcts.length;
}
