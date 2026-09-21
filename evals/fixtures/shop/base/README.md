# fixture-shop

Tiny order library.

- `applyCoupon(total, coupon)` — coupons apply to orders of **$50 or more** (`coupon.minSpend`).
- `averageItemPrice(items)` — returns 0 for an empty cart.
