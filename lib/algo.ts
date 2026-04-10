export const MICRO_ALGO_PER_ALGO = 1_000_000;

export function toMicroAlgo(algo: number) {
  return Math.round(algo * MICRO_ALGO_PER_ALGO);
}

export function fromMicroAlgo(value: number | string | null | undefined) {
  return Number(value ?? 0) / MICRO_ALGO_PER_ALGO;
}

export function formatAlgo(value: number | string | null | undefined, fractionDigits = 6) {
  return fromMicroAlgo(value).toFixed(fractionDigits);
}

export function formatMicroAlgo(value: number | string | null | undefined) {
  const numeric = Math.round(Number(value ?? 0));
  return new Intl.NumberFormat("en-US").format(Number.isFinite(numeric) ? numeric : 0);
}

export function formatAlgoWithMicro(value: number | string | null | undefined, fractionDigits = 6) {
  return `${formatAlgo(value, fractionDigits)} ALGO (${formatMicroAlgo(value)} microALGO)`;
}
