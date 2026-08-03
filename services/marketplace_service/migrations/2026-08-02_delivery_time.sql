-- 🚚 Delivery time for popularity boosts
ALTER TABLE listings ADD COLUMN delivery_time TEXT;
ALTER TABLE purchases ADD COLUMN delivery_time TEXT;
