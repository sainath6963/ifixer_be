# Customer saved addresses

Phase 11 adds a customer-owned address book for faster checkout. Addresses remain embedded in the customer document because the collection is bounded, normally read as one unit, and updated transactionally with its audit event.

## API contract

Every route requires the customer access cookie and returns `Cache-Control: no-store`. Mutations also require the customer-scoped CSRF cookie and matching `X-CSRF-Token` header described in [customer-auth-and-cart.md](customer-auth-and-cart.md).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/customer/addresses` | Return the current address book |
| `POST` | `/api/v1/customer/addresses` | Add an address |
| `PUT` | `/api/v1/customer/addresses/:addressId` | Replace every editable field |
| `POST` | `/api/v1/customer/addresses/:addressId/default` | Make one address the default |
| `DELETE` | `/api/v1/customer/addresses/:addressId` | Delete an address |

The list and every successful mutation return the complete current book:

```json
{
  "version": 4,
  "limit": 10,
  "addresses": [
    {
      "id": "66b5e4e6d81dd7fdde34a111",
      "label": "Home",
      "fullName": "Asha Kulkarni",
      "phone": "+919876543210",
      "line1": "12 Culture Lane",
      "city": "Pune",
      "state": "Maharashtra",
      "postalCode": "411001",
      "countryCode": "IN",
      "isDefault": true
    }
  ]
}
```

Create and replace requests include the address fields plus `expectedVersion`. Create may also include `isDefault`. Default and delete requests contain only `expectedVersion`.

## Invariants and concurrency

- A customer can save at most 10 addresses.
- An empty address book has no default; a non-empty book has exactly one.
- The first address becomes default even when the client sends `isDefault: false`.
- Making a new address default clears the previous default atomically.
- Deleting the default promotes the first remaining address.
- Address IDs are unique MongoDB ObjectIds and cannot be supplied by the client.
- `countryCode` is currently restricted to `IN`; PIN codes must contain exactly six digits.
- Names, labels, location fields, and phone numbers are length/format validated and trimmed server-side.

Every mutation compares `expectedVersion` with the current customer document version. A stale request returns HTTP 409 with `ADDRESS_BOOK_VERSION_CONFLICT`; reload the address book and let the customer retry. The client must never silently overwrite the newer server state.

The service performs the state change and its `CUSTOMER_ADDRESS_*` audit event in one MongoDB transaction. In addition to application validation, the collection validator enforces the 10-item bound, unique IDs, and exactly one default.

## Checkout behavior

The frontend selects the default address initially and copies its values into the checkout form. Customers can choose another saved address or edit any field as one-off delivery details. Orders store their own immutable shipping-address snapshot; changing or deleting an address later never changes an existing order.

Checkout continues to validate and price the submitted shipping address server-side. A saved address ID is not trusted as a substitute for shipping fields and is not required to create an order.

## Deployment

Migration `011-customer-saved-addresses` installs the strict customer address-book validator. Run it once before starting the new application version:

```bash
npm run build
npm run db:migrate:prod
npm run start:prod
```

After deployment, verify one create/edit/default/delete lifecycle and confirm that checkout preselects the remaining default address. Roll back application containers by immutable tag if required; do not reverse the collection validator without a migration-specific recovery plan.
