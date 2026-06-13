'use strict'

// JS-only stub for bare-performance native binding (worklet-safe, no require.addon).
const TIME_ORIGIN = Date.now()

function nowNs () {
  return BigInt(Date.now()) * 1000000n
}

module.exports = {
  TIME_ORIGIN,
  now: nowNs,
  idleTime: () => 0,
  metricsInfo: () => ({ loopCount: 0, events: 0, eventsWaiting: 0 }),
  constants: {
    MARK_COMPACT: 4,
    GENERATIONAL: 1,
  },
  histogramInit: () => ({}),
  histogramMax: () => 0,
  histogramMin: () => 0,
  histogramMean: () => 0,
  histogramStddev: () => 0,
  histogramPercentiles: () => [],
  histogramRecord: () => {},
  histogramReset: () => {},
  histogramCount: () => 0,
  histogramExceeds: () => 0,
  gcStart: () => {},
  gcStop: () => {},
}
