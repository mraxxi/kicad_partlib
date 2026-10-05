-- --------------------------------------------------------------------------
-- 0003_sheet_vocabulary -- adopt the owner's own category list and FX rate.
--
-- The Google Sheet prototype (Parts Inventory & Purchasing.xlsx, 'Lists' tab)
-- is the vocabulary the owner already thinks in: "Passive - Resistor",
-- "IC - Audio", ... 0002 seeded generic names instead. Renaming (not
-- delete+insert) keeps ids and any references stable, and every statement is a
-- no-op when replayed.
-- --------------------------------------------------------------------------
UPDATE OR IGNORE categories SET name = 'Passive - Resistor'   WHERE name = 'Resistor';
UPDATE OR IGNORE categories SET name = 'Passive - Capacitor'  WHERE name = 'Capacitor';
UPDATE OR IGNORE categories SET name = 'Passive - Inductor'   WHERE name = 'Inductor';
UPDATE OR IGNORE categories SET name = 'Discrete - Diode'     WHERE name = 'Diode';
UPDATE OR IGNORE categories SET name = 'Discrete - MOSFET'    WHERE name = 'MOSFET';
UPDATE OR IGNORE categories SET name = 'Discrete - Transistor' WHERE name = 'Transistor';
UPDATE OR IGNORE categories SET name = 'IC - Op Amp'          WHERE name = 'Op Amp';
UPDATE OR IGNORE categories SET name = 'IC - Audio'           WHERE name = 'Audio Amplifier';
UPDATE OR IGNORE categories SET name = 'IC - Power'           WHERE name = 'Regulator';
UPDATE OR IGNORE categories SET name = 'IC - MCU'             WHERE name = 'MCU';
UPDATE OR IGNORE categories SET name = 'Optoelectronics - LED' WHERE name = 'LED';

-- 'Power Management' and 'Regulator' were one category in the sheet ('IC - Power').
UPDATE parts SET category_id = (SELECT id FROM categories WHERE name = 'IC - Power')
 WHERE category_id = (SELECT id FROM categories WHERE name = 'Power Management')
   AND EXISTS (SELECT 1 FROM categories WHERE name = 'IC - Power');
DELETE FROM categories WHERE name = 'Power Management'
   AND EXISTS (SELECT 1 FROM categories WHERE name = 'IC - Power');

INSERT OR IGNORE INTO categories(name) VALUES
    ('Connector'), ('Display'), ('IC - Memory'), ('IC - Other'), ('Mechanical'),
    ('Module'), ('Crystal / Oscillator'), ('Switch'), ('Other'),
    ('Discrete - Transistor'), ('IC - Power'), ('IC - MCU'), ('IC - Op Amp'), ('IC - Audio');

-- The sheet's rate (pluang.com USD/IDR converter, 2026-10-06). Only replaces the
-- 0002 placeholder, never a rate the owner has since set.
UPDATE settings SET value = '17893000000' WHERE key = 'fx.usd_idr_micro' AND value = '16500000000';
INSERT OR IGNORE INTO settings(key, value) VALUES
    ('fx.source', 'pluang.com USD/IDR converter, 2026-10-06 (from the original sheet)');
