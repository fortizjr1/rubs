-- Where to send a moved-out resident's final bill.
ALTER TABLE tenants ADD COLUMN forwarding_address TEXT;
