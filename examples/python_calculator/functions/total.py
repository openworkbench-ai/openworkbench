from decimal import Decimal, ROUND_HALF_UP


def calculate_total(price, quantity, discount_percent=0):
    subtotal = Decimal(str(price)) * quantity
    discount = subtotal * Decimal(str(discount_percent)) / 100
    total = (subtotal - discount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {"total": float(total), "quantity": quantity}
