'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCartAmounts } = require('../lib/rules.js');
const row = (minor, quantity, lineTotal = false) => ({ minor, quantity, lineTotal });
test('cart subtotal distinguishes unit, line and mixed representations', () => {
  assert.deepEqual(resolveCartAmounts([row(10500, 2), row(1400, 1)], 22400), [21000, 1400]);
  assert.deepEqual(resolveCartAmounts([row(1600, 2)], 1600), [1600]);
  assert.deepEqual(resolveCartAmounts([row(10500, 2), row(1600, 2)], 22600), [21000, 1600]);
});
test('multiple matching assignments remain unknown', () => {
  assert.equal(resolveCartAmounts([row(100, 2), row(100, 2)], 300), null);
});
test('discounts, shipping and incomplete sums cannot manufacture a total', () => {
  for (const total of [20000, 21500, 99999]) assert.equal(resolveCartAmounts([row(10500, 2)], total), null);
});
test('proven line subtotal is never multiplied again', () => {
  assert.deepEqual(resolveCartAmounts([row(1600, 2, true)], 1600), [1600]);
  assert.equal(resolveCartAmounts([row(1600, 2, true)], 3200), null);
});
test('invalid inputs and large carts are bounded', () => {
  for (const quantity of [0, -1, 1.5, 1000, NaN]) assert.equal(resolveCartAmounts([row(100, quantity)], 100), null);
  assert.equal(resolveCartAmounts(Array(41).fill(row(100, 1)), 4100), null);
  assert.equal(resolveCartAmounts([row(100, 1)], Infinity), null);
  assert.equal(resolveCartAmounts([], 100), null);
});
