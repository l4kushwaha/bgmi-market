
def estimate_price(mythic, legendary, x_suit):
    base_value = mythic * 200 + legendary * 100 + x_suit * 500
    min_value = base_value * 0.5
    max_value = base_value * 0.75
    return {"estimated_value": base_value, "min_price": min_value, "max_price": max_value}
