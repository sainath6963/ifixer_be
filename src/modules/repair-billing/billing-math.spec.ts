import { invoiceAmounts } from './billing-math';
const lines = (
  price: number,
  quantity = 1,
): Array<{ kind: string; description: string; quantity: number; unitPriceInPaise: number }> => [
  { kind: 'SERVICE', description: 'Repair', quantity, unitPriceInPaise: price },
];
describe('repair invoice integer arithmetic', () => {
  it('rounds half a paise upward separately for each configured tax after discount', () => {
    expect(
      invoiceAmounts(lines(105), 5, [
        { label: 'A', rateBps: 50 },
        { label: 'B', rateBps: 50 },
      ]),
    ).toMatchObject({
      subtotalInPaise: 105,
      taxableInPaise: 100,
      taxes: [{ amountInPaise: 1 }, { amountInPaise: 1 }],
      totalInPaise: 102,
    });
  });
  it('keeps fully discounted work at zero including taxes', () => {
    expect(
      invoiceAmounts(lines(19995, 3), 59985, [{ label: 'Configured tax', rateBps: 1800 }])
        .totalInPaise,
    ).toBe(0);
  });
  it('rejects discounts above subtotal and totals beyond the supported cap', () => {
    expect(() => invoiceAmounts(lines(100), 101, [])).toThrow();
    expect(() => invoiceAmounts(lines(1000000000), 0, [{ label: 'Tax', rateBps: 1 }])).toThrow();
    expect(() => invoiceAmounts(lines(1000000000, 2), 0, [])).toThrow();
  });
});
