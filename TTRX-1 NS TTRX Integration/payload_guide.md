# Dosage Form
{ 
  "code": "Test2", 
  "is_active": true, 
  "name": "Test2" 
}

# Location
{
    "create_default_storage_area": true,                              // Always true
    "custom_uuid": "TEST-UUID-00000001",
    "gs1_id": "abc123",
    "gs1_sgln": "test123",
    "is_active": true,
    "is_unselectable_location": false,                                // Always false
    "location_detail": "2",
    "location_lat": "56.998855",
    "location_long": "-101.027169",
    "manufacturing_location_prefix_or_suffix_id_value": "",           // Always Empty
    "name": "Test1",
    "parent_location_uuid": ""
}

# Address
{
    "address_gs1_id": "",                                             // Always Empty
    "address_nickname": "Test A BCD Label",                           // Address Label or 'Main Address'
    "city": "City",
    "country_code": "US",
    "gs1_sgln": "1234123412341234",
    "is_licence_required": false,
    "line1": "Address 1",
    "line2": "Address 2",
    "phone": "1231231231",
    "recipient_name": "Test A BCD Addressee",
    "state": "NJ",
    "zip": "08901"
}

# Customer
{
    "custom_uuid": "b5969a19-eacc-4b4b-a12a-9c2fde24722d",
    "name": "Test1",
    "gs1_id": "1234",
    "gs1_company_id": "",                                              // Always Empty
    "gs1_sgln": "",                                                    // Always Empty
    "type": "CUSTOMER",                                                // Always 'CUSTOMER'
    "parent_tp_uuid": "TEST-UUID-00000001",
    "customer_id": "392",
    "friendly_name": "",                                               // Always Empty
    "default_billing_address_uuid": "TEST-UUID-00000001",
    "default_shipping_address_uuid": "TEST-UUID-00000001",
    "phone": "(123) 456-7890",
    "phone_ext": "",                                                   // Always Empty
    "notification_email": "test@gmail.com",
    "new_trx_notification_type": "ALL",                                // Always 'ALL'
    "flag_notification_name": "",                                      // Always Empty
    "flag_notification_email": "",                                     // Always Empty
    "flag_notification_phone": "",                                     // Always Empty
    "flag_notification_phone_ext": "",                                 // Always Empty
    "external_reference": "1841",
    "is_active": true,
    "inbound_shipping_check_percentage": "",                           // Always Empty
    "outbound_shipping_check_percentage": "",                          // Always Empty
    "sender_id": "",                                                   // Always Empty
    "receiver_id": "",                                                 // Always Empty
    "as2_id": "",                                                      // Always Empty
    "is_a_3pl_client": false,                                          // Always false
    "3pl_is_our_company_is_internal_entity_of_tp": false,              // Always false
    "is_send_outbond_epcis": false,                                    // Always false
    "is_send_outbond_x12": false,                                      // Always false
    "default_outbound_transaction_type": "SALES",                      // Always 'SALES'
    "send_copy_outbound_shipment_external_trading_entity_id": "",      // Always Empty
    "outbound_epcis_generator_type": "",                               // Always Empty
    "is_enable_transmit_outbound_850": "",                             // Always Empty
    "omit_comm_aggr_in_epcis": false                                   // Always false
}

# Vendor
{
    "custom_uuid": "346d2399-15c9-4acf-b047-0e06f7ed386e",
    "name": "Test 1",
    "gs1_id": "1234123412341",
    "gs1_company_id": "",                                              // Always Empty
    "gs1_sgln": "",                                                    // Always Empty
    "type": "VENDOR",                                                  // Always 'VENDOR'
    "parent_tp_uuid": "",
    "customer_id": "Test 1",
    "friendly_name": "",                                               // Always Empty
    "default_billing_address_uuid": "36887140-ea13-4eee-bd35-d61878969f84",
    "default_shipping_address_uuid": "36887140-ea13-4eee-bd35-d61878969f84",
    "phone": "(123) 412-3411",
    "phone_ext": "",                                                   // Always Empty
    "notification_email": "test4@gamil.com",
    "new_trx_notification_type": "ALL",                                // Always 'ALL'
    "flag_notification_name": "",                                      // Always Empty
    "flag_notification_email": "",                                     // Always Empty
    "flag_notification_phone": "",                                     // Always Empty
    "flag_notification_phone_ext": "",                                 // Always Empty
    "external_reference": "1844",
    "is_active": true,
    "inbound_shipping_check_percentage": "",                           // Always Empty
    "outbound_shipping_check_percentage": "",                          // Always Empty
    "sender_id": "",                                                   // Always Empty
    "receiver_id": "",                                                 // Always Empty
    "as2_id": "",                                                      // Always Empty
    "is_a_3pl_client": false,                                          // Always false
    "3pl_is_our_company_is_internal_entity_of_tp": false,              // Always false
    "is_send_outbond_epcis": false,                                    // Always false
    "is_send_outbond_x12": false,                                      // Always false
    "default_outbound_transaction_type": "SALES",                      // Always 'SALES'
    "send_copy_outbound_shipment_external_trading_entity_id": "",      // Always Empty
    "outbound_epcis_generator_type": "",                               // Always Empty
    "is_enable_transmit_outbound_850": "",                             // Always Empty
    "omit_comm_aggr_in_epcis": false                                   // Always false
}

# Item/UOM Details
