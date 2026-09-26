# Verified product reviews

Phase 17 adds one review per customer/product, restricted to customers whose owned order containing that product has reached `DELIVERED`. Customer content is private until an authenticated admin publishes it.

## API surface

Public reads return only published content and use short public caching:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/catalog/products/:productId/reviews?page=1&limit=10` | Published reviews plus exact count/average |

Customer routes require the customer access cookie and customer CSRF protection. Reads are `no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/customer/reviews/product/:productId` | Delivered-order eligibility and owned review state |
| `POST` | `/customer/reviews` | Submit the first review as `PENDING` |
| `PATCH` | `/customer/reviews/:reviewId` | Revise using `expectedVersion`; returns to `PENDING` |
| `POST` | `/customer/reviews/:reviewId/withdraw` | Withdraw using `expectedVersion` |

Admin routes require admin cookie/CSRF authentication and permit both OWNER and STAFF moderation:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/reviews?status=PENDING&rating=5&search=linen` | Search/filter the moderation queue |
| `PATCH` | `/admin/reviews/:reviewId/moderation` | Publish or reject using `expectedVersion` |

A rejection requires a customer-visible reason. A rejected or withdrawn review can be revised and resubmitted. Editing or withdrawing a published review immediately removes it from the public result and rating summary in the same transaction.

## Privacy and trust boundary

Eligibility is proven only from the server-owned `orders` collection: `customerId` must match, `items.productId` must contain the requested product and `fulfillmentStatus` must be `DELIVERED`. The browser cannot provide an order ID or a verified-purchase flag.

The review stores immutable order/product snapshots for moderation. Public responses omit customer ID, order ID/number, moderation metadata and rejection feedback. The visible name is reduced to a first name and last initial, or `Verified customer` when no name exists.

Every customer submit/update/withdraw and every admin publish/reject creates an audit record. Customer ownership and admin role guards are enforced before the service boundary, while the service rechecks document ownership and optimistic versions.

## Rating consistency

Published totals live in `product_review_summaries`, separate from product documents so moderation cannot create catalog editing conflicts. Publication atomically increments `reviewCount` and `ratingTotal`; rejection, customer edit and withdrawal atomically decrement them. The summary write and review status write share one MongoDB transaction.

The public average is calculated from integer totals and rounded to one decimal at response time. MongoDB collection validation requires either a zero/zero summary or `reviewCount <= ratingTotal <= reviewCount * 5`. Review documents also have strict state-specific moderation timestamp/reason invariants.

## Migration and deployment

Migration `017-verified-product-reviews` creates `product_reviews` and `product_review_summaries`, installs unique customer/product and product-summary indexes, creates public/moderation queue indexes and enables strict collection validators.

Run before starting Phase 17 application containers:

```bash
npm run db:migrate:prod
npm run start:prod
```

MongoDB must remain a replica set. After deployment, use a delivered Test Mode order to submit a review, confirm it is absent publicly while pending, publish it from `/admin/reviews`, verify the public masked name/count/average, then withdraw it and confirm the public summary returns to its prior value.
