import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  pickAnchorItem,
  rowKeySelector,
  shouldAdjustSizeAboveFold,
  shouldApplyAnchorDelta,
  viewportAnchorDelta,
} from './scrollAnchor.ts'

describe('pickAnchorItem', () => {
  const items = [
    { start: 0, end: 100 },
    { start: 100, end: 220 },
    { start: 220, end: 300 },
  ]

  it('picks the item spanning the scroll offset', () => {
    assert.equal(pickAnchorItem(items, 150), items[1])
  })

  it('picks the first item at or below scroll offset', () => {
    assert.equal(pickAnchorItem(items, 0), items[0])
    assert.equal(pickAnchorItem(items, 220), items[2])
  })

  it('returns null for empty list', () => {
    assert.equal(pickAnchorItem([], 0), null)
  })
})

describe('viewportAnchorDelta', () => {
  it('is zero when the row stayed put', () => {
    assert.equal(viewportAnchorDelta(200, 100, 100), 0)
  })

  it('is positive when content was prepended above (row moved down)', () => {
    // scroller top 100, row was at viewportOffset 80 → row top 180
    // after prepend row top 380 → delta +200
    assert.equal(viewportAnchorDelta(380, 100, 80), 200)
  })

  it('is negative when content above shrank', () => {
    assert.equal(viewportAnchorDelta(120, 100, 80), -60)
  })
})

describe('shouldApplyAnchorDelta', () => {
  it('ignores sub-pixel noise', () => {
    assert.equal(shouldApplyAnchorDelta(0.2), false)
    assert.equal(shouldApplyAnchorDelta(0.8), true)
  })
})

describe('shouldAdjustSizeAboveFold', () => {
  it('locks while restore is in progress', () => {
    assert.equal(shouldAdjustSizeAboveFold(50, 100, true), false)
  })

  it('adjusts only fully-above-fold rows when idle', () => {
    assert.equal(shouldAdjustSizeAboveFold(50, 100, false), true)
    assert.equal(shouldAdjustSizeAboveFold(150, 100, false), false)
  })

  it('never adjusts while scrolling or moving upward', () => {
    assert.equal(
      shouldAdjustSizeAboveFold(50, 100, false, { isScrolling: true }),
      false,
    )
    assert.equal(
      shouldAdjustSizeAboveFold(50, 100, false, {
        scrollDirection: 'backward',
      }),
      false,
    )
  })
})

describe('rowKeySelector', () => {
  it('quotes the key for querySelector', () => {
    assert.match(rowKeySelector('abc'), /data-tg-row-key="abc"/)
  })
})
