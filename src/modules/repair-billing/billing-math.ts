import { BadRequestException } from '@nestjs/common';
import type { InvoiceLineDto, TaxDto } from './repair-billing.dto';
export function invoiceAmounts(
  lines: InvoiceLineDto[],
  discount: number,
  taxes: TaxDto[],
): {
  subtotalInPaise: number;
  discountInPaise: number;
  taxableInPaise: number;
  totalInPaise: number;
  taxes: Array<TaxDto & { amountInPaise: number }>;
} {
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceInPaise, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal > 1000000000 || discount > subtotal)
    throw new BadRequestException('Discount or invoice subtotal is outside the supported amount');
  const taxable = subtotal - discount;
  const calculated = taxes.map((tax) => ({
    label: tax.label,
    rateBps: tax.rateBps,
    amountInPaise: Number((BigInt(taxable) * BigInt(tax.rateBps) + 5000n) / 10000n),
  }));
  const total = taxable + calculated.reduce((sum, tax) => sum + tax.amountInPaise, 0);
  if (total > 1000000000)
    throw new BadRequestException('Invoice total exceeds the supported amount');
  return {
    subtotalInPaise: subtotal,
    discountInPaise: discount,
    taxableInPaise: taxable,
    taxes: calculated,
    totalInPaise: total,
  };
}
