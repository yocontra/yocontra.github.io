import { expect, test as it } from 'bun:test'
import { nativeForeground } from '../tools/content/simulator-hid.ts'
import {
  frameForAX,
  nativeSafari,
  preflightIssues,
  QA_DEVICE,
  webFrame,
} from '../tools/content/simulator-native.ts'

// Minimal actual COMPLETE fields from failed preflight5865. AX has no invented bundle field.
const frame = { x: 0, y: 0, width: 375, height: 664 }
const page = {
  url: 'http://127.0.0.1:4398/experiments/out-west/frontier/?server=remote',
  visible: 'visible',
  focused: true,
  width: 375,
  height: 664,
  canvas: frame,
}
const application = { type: 'Application', pid: 84_918 }
const canvas = {
  type: 'WebAccessibilityObjectWrapper',
  label: 'Out West game',
  traits: ['WebContent', 'Scrollable', 'TextOperationsAvailable'],
  frame,
}
const start = {
  type: 'Button',
  label: 'Start 2s headless preflight',
  frame: { x: 198, y: 48, width: 166, height: 40 },
}
const ax = {
  target: { kind: 'frontmost', pid: null },
  backend: 'axbridge-exclusive',
  elements: [application, application, canvas, start],
}
const apps = [{ bundle_id: 'com.apple.mobilesafari', pid: '84918', process_state: 'Running' }]
it('reads actual COMPLETE labels and measured game-canvas bounds without selecting unrelated wrappers', () => {
  expect(frameForAX(ax, start.label)).toEqual(start.frame)
  expect(webFrame(ax, page)).toEqual(frame)
  expect(
    webFrame(
      {
        elements: [
          ...ax.elements,
          { type: 'WebArea', frame: { height: 664, width: 375, x: 0, y: 0 } },
        ],
      },
      page,
    ),
  ).toEqual(frame)
  expect(
    webFrame({ ...ax, elements: [{ ...canvas, label: 'Unrelated' }, ...ax.elements] }, page),
  ).toEqual(frame)
  expect(webFrame(ax)).toBeUndefined()
  expect(webFrame({ elements: [{ ...canvas, label: 'Unrelated' }] }, page)).toBeUndefined()
  expect(webFrame({ elements: [{ ...canvas, traits: [] }] }, page)).toBeUndefined()
  expect(frameForAX({ ...start, frame: { ...frame, width: 0 } }, start.label)).toBeUndefined()
})
it('rejects malformed, ambiguous or CSS-inconsistent native game-canvas frames', () => {
  for (const invalid of [
    { ...canvas, frame: { ...frame, width: 0 } },
    { ...canvas, frame: { ...frame, y: Number.NaN } },
    { ...canvas, frame: { ...frame, height: 600 } },
    { ...canvas, frame: '{{0,0},{375,664}}' },
  ]) {
    expect(webFrame({ elements: [invalid] }, page)).toBeUndefined()
  }
  expect(
    webFrame({ elements: [canvas, { ...canvas, frame: { ...frame, x: 20 } }] }, page),
  ).toBeUndefined()
  expect(webFrame(ax, { ...page, width: Number.POSITIVE_INFINITY })).toBeUndefined()
  expect(webFrame(ax, { ...page, canvas: null })).toBeUndefined()
  expect(webFrame(ax, { ...page, canvas: { ...frame, x: 20 } })).toBeUndefined()
  expect(webFrame({ type: 'WebArea', frame }, page)).toEqual(frame)
  expect(webFrame({ type: 'WebArea', frame: { ...frame, height: 812 } }, page)).toBeUndefined()
})
it('derives a scaled viewport only from actual native and CSS game-canvas measurements', () => {
  const actual = { ...canvas, frame: { x: 20, y: 40, width: 600, height: 1200 } }
  expect(
    webFrame(
      { elements: [actual] },
      {
        ...page,
        canvas: { x: 10, y: 20, width: 300, height: 600 },
      },
    ),
  ).toEqual({ x: 0, y: 0, width: 750, height: 1328 })
})
it('joins frontmost native Application PID to unique native CLI or public-client app mappings', () => {
  expect(nativeSafari(ax, apps)).toEqual({ bundle: 'com.apple.mobilesafari', pid: 84_918 })
  expect(nativeSafari(ax, [{ bundle_id: 'com.apple.mobilesafari', process_id: 84_918 }])).toEqual({
    bundle: 'com.apple.mobilesafari',
    pid: 84_918,
  })
  expect(nativeSafari(ax, [{ ...apps[0], process_state: 'Unknown' }])).toEqual({
    bundle: 'com.apple.mobilesafari',
    pid: 84_918,
  })
  expect(nativeSafari(ax)).toBeUndefined()
  expect(nativeSafari(apps)).toBeUndefined()
})
it('rejects missing, wrong, conflicting and ambiguous PID or bundle mappings', () => {
  for (const invalid of [
    [],
    [{ bundle_id: 'com.apple.mobilesafari', process_state: 'Running' }],
    [{ bundle_id: 'other', pid: '84918' }],
    [{ ...apps[0], pid: '84919' }],
    [apps[0], apps[0]],
    [apps[0], { ...apps[0], pid: '84919' }],
    [apps[0], { bundle_id: 'other', pid: '84918' }],
    [{ ...apps[0], process_id: 84_919 }],
  ]) {
    expect(nativeSafari(ax, invalid)).toBeUndefined()
  }
  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0',
    '084918',
    '84918.0',
    ' 84918',
  ]) {
    expect(nativeSafari(ax, [{ ...apps[0], pid: invalid }])).toBeUndefined()
    expect(
      nativeSafari({ ...ax, elements: [{ ...application, pid: invalid }] }, apps),
    ).toBeUndefined()
  }
  expect(
    nativeSafari({ ...ax, elements: [application, { ...application, pid: 84_919 }] }, apps),
  ).toBeUndefined()
  expect(
    nativeSafari({ ...ax, elements: [{ ...application, process_id: 84_919 }] }, apps),
  ).toBeUndefined()
  expect(nativeSafari({ ...ax, target: { kind: 'pid', pid: 84_918 } }, apps)).toBeUndefined()
  expect(nativeSafari({ elements: ax.elements }, apps)).toBeUndefined()
})
it('requires separately retained before and after native mappings in preflight identity checks', () => {
  const evidence = { beforeAX: ax, afterAX: ax, expectedURL: page.url, receipt: {} }
  const issue = 'Native guest foreground Safari identity unavailable or changed'
  expect(preflightIssues({ ...evidence, beforeApps: apps, afterApps: apps })).not.toContain(issue)
  expect(preflightIssues({ ...evidence, beforeApps: apps })).toContain(issue)
  expect(preflightIssues({ ...evidence, afterApps: apps })).toContain(issue)
  expect(
    preflightIssues({ ...evidence, beforeApps: apps, afterApps: [{ ...apps[0], pid: '84919' }] }),
  ).toContain(issue)
})
it('joins each timeline sample mapping and verified companion target without relaxing foreground timing', () => {
  const samples = Array.from({ length: 61 }, (_, i) => ({
    wall: 1000 + i * 1000,
    ax,
    apps,
    companionUDID: QA_DEVICE,
    orientation: 'PORTRAIT',
  }))
  const expected = { start: 1000, end: 61_000, orientation: 'PORTRAIT', udid: QA_DEVICE }
  expect(nativeForeground(samples, expected).passed).toBe(true)
  expect(
    nativeForeground(
      samples.map((s, i) => (i === 2 ? { ...s, apps: [] } : s)),
      expected,
    ).passed,
  ).toBe(false)
  expect(
    nativeForeground(
      samples.map((s, i) => (i === 2 ? { ...s, companionUDID: 'other' } : s)),
      expected,
    ).passed,
  ).toBe(false)
  expect(
    nativeForeground(
      samples.map((s, i) =>
        i === 2 ? { ...s, ax: { ...ax, target: { kind: 'pid', pid: 84_918 } } } : s,
      ),
      expected,
    ).passed,
  ).toBe(false)
  expect(
    nativeForeground(
      samples.filter((_, i) => i !== 5),
      expected,
    ).passed,
  ).toBe(false)
})
