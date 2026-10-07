# Authentication
NetSuite → Middleware: API Key
Middleware → NetSuite: OAuth 2.0 – JWT Bearer Grant (Credentials will be shared)

# Dosage Form
Create Endpoint: https://api.tracktraceweb.com/2.0/products/pharmaceutical/dosage_forms
Update Endpoint: https://api.tracktraceweb.com/2.0/products/pharmaceutical/dosage_forms/{{tran_uuid}}
Method: POST
Payload:
{ 
  "code": "Test2", 
  "is_active": true, 
  "name": "Test2" 
}

# Location
Create Endpoint: https://api.tracktraceweb.com/2.0/locations
Update Endpoint: https://api.tracktraceweb.com/2.0/locations/{{tran_uuid}}
Method: POST
Payload:
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
Create Endpoint: https://api.tracktraceweb.com/2.0/trading_partners/{{tran_uuid}}/addresses
Update Endpoint: https://api.tracktraceweb.com/2.0/trading_partners/{{tran_uuid}}/addresses/{{addr_uuid}}
Method: POST
Payload:
{
    "address_gs1_id": "",                                             // Always Empty
    "address_nickname": "Test A BCD Label",                           // Address Label; 'Address N' by line when unlabelled
    "city": "City",
    "country_code": "US",
    "gs1_sgln": "1234123412341234",
    "is_licence_required": false,                                     // Always false
    "line1": "Address 1",
    "line2": "Address 2",
    "phone": "1231231231",
    "recipient_name": "Test A BCD Addressee",                         // Addressee, falling back to the parent record name
    "state": "NJ",
    "zip": "08901"
}

# Customer
Create Endpoint: https://api.tracktraceweb.com/2.0/trading_partners/
Update Endpoint: https://api.tracktraceweb.com/2.0/trading_partners/{{tran_uuid}}
Method: POST
Payload:
{
    "custom_uuid": "b5969a19-eacc-4b4b-a12a-9c2fde24722d",
    "name": "Test1",                                                    // Company Name; Alternate Name when Individual; else Entity ID
    "gs1_id": "1234",
    "gs1_company_id": "",                                               // Always Empty
    "gs1_sgln": "",                                                     // Always Empty
    "type": "CUSTOMER",                                                 // Always 'CUSTOMER'
    "parent_tp_uuid": "TEST-UUID-00000001",                             // Parent customer's UUID; empty when there is no parent
    "customer_id": "392",                                               // NetSuite Entity ID
    "friendly_name": "",                                                // Always Empty
    "default_billing_address_uuid": "TEST-UUID-00000001",               // UUID of the default billing address line; empty until accepted
    "default_shipping_address_uuid": "TEST-UUID-00000001",              // UUID of the default shipping address line; empty until accepted
    "phone": "(123) 456-7890",
    "phone_ext": "",                                                    // Always Empty
    "notification_email": "test@gmail.com",
    "new_trx_notification_type": "ALL",                                 // Always 'ALL'
    "flag_notification_name": "",                                       // Always Empty
    "flag_notification_email": "",                                      // Always Empty
    "flag_notification_phone": "",                                      // Always Empty
    "flag_notification_phone_ext": "",                                  // Always Empty
    "external_reference": "1841",                                       // NetSuite internal id
    "is_active": true,
    "inbound_shipping_check_percentage": "",                            // Always Empty
    "outbound_shipping_check_percentage": "",                           // Always Empty
    "sender_id": "",                                                    // Always Empty
    "receiver_id": "",                                                  // Always Empty
    "as2_id": "",                                                       // Always Empty
    "is_a_3pl_client": false,                                           // Always false
    "3pl_is_our_company_is_internal_entity_of_tp": false,               // Always false
    "is_send_outbond_epcis": false,                                     // Always false
    "is_send_outbond_x12": false,                                       // Always false
    "default_outbound_transaction_type": "SALES",                       // Always 'SALES'
    "send_copy_outbound_shipment_external_trading_entity_id": "",       // Always Empty
    "outbound_epcis_generator_type": "",                                // Always Empty
    "is_enable_transmit_outbound_850": "",                              // Always Empty
    "omit_comm_aggr_in_epcis": false                                    // Always false
}

# Vendor
Create Endpoint: https://api.tracktraceweb.com/2.0/trading_partners/
Update Endpoint: https://api.tracktraceweb.com/2.0/trading_partners/{{tran_uuid}}
Method: POST
Payload:
{
    "custom_uuid": "346d2399-15c9-4acf-b047-0e06f7ed386e",
    "name": "Test 1",                                                   // Company Name; falls back to Entity ID
    "gs1_id": "1234123412341",
    "gs1_company_id": "",                                               // Always Empty
    "gs1_sgln": "",                                                     // Always Empty
    "type": "VENDOR",                                                   // Always 'VENDOR'
    "parent_tp_uuid": "",                                               // Always Empty - a Vendor has no parent hierarchy
    "customer_id": "Test 1",                                            // NetSuite Entity ID
    "friendly_name": "",                                                // Always Empty
    "default_billing_address_uuid": "36887140-ea13-4eee-bd35-d61878969f84", // UUID of the default billing address line; empty until accepted
    "default_shipping_address_uuid": "36887140-ea13-4eee-bd35-d61878969f84", // UUID of the default shipping address line; empty until accepted
    "phone": "(123) 412-3411",
    "phone_ext": "",                                                    // Always Empty
    "notification_email": "test4@gamil.com",
    "new_trx_notification_type": "ALL",                                 // Always 'ALL'
    "flag_notification_name": "",                                       // Always Empty
    "flag_notification_email": "",                                      // Always Empty
    "flag_notification_phone": "",                                      // Always Empty
    "flag_notification_phone_ext": "",                                  // Always Empty
    "external_reference": "1844",                                       // NetSuite internal id
    "is_active": true,
    "inbound_shipping_check_percentage": "",                            // Always Empty
    "outbound_shipping_check_percentage": "",                           // Always Empty
    "sender_id": "",                                                    // Always Empty
    "receiver_id": "",                                                  // Always Empty
    "as2_id": "",                                                       // Always Empty
    "is_a_3pl_client": false,                                           // Always false
    "3pl_is_our_company_is_internal_entity_of_tp": false,               // Always false
    "is_send_outbond_epcis": false,                                     // Always false
    "is_send_outbond_x12": false,                                       // Always false
    "default_outbound_transaction_type": "SALES",                       // Always 'SALES'
    "send_copy_outbound_shipment_external_trading_entity_id": "",       // Always Empty
    "outbound_epcis_generator_type": "",                                // Always Empty
    "is_enable_transmit_outbound_850": "",                              // Always Empty
    "omit_comm_aggr_in_epcis": false                                    // Always false
}

# Item/UOM Details
Create Endpoint: https://api.tracktraceweb.com/2.0/products/
Update Endpoint: https://api.tracktraceweb.com/2.0/products/{{tran_uuid}}
Method: POST
Payload:
{
    custom_uuid: "",                                                    // Empty on create; the TrackTrace UUID on every later call
    type: "Pharmaceutical",                                             // From config or default to 'Pharmaceutical'
    gs1_company_prefix: "0300026",
    gs1_id: "014511",
    upc: "00300026145113",                                              // UOM Detail UPC, falling back to the item UPC
    sku: "Test Lot Inventory Item 3",                                   // NetSuite Item ID (not the NDC)
    type_class: "",                                                     // Always empty
    category_id: "",                                                    // Always empty
    status: "AVAILABLE",                                                // Based on item inactive status
    manufacturer_id: "",                                                // Always empty
    manufacturer_default_address_uuid: "",                              // Always empty
    is_active: true,
    update_product_descriptions: true,                                  // Always true
    product_descriptions: [
        {
            language_code: "en",                                        // Based config or default to 'en'
            name: "Baqsimi 3 mg Powder",                                // Display Name, falling back to Item ID
            description: "Baqsimi 3 mg Powder",                         // Sales Description, then Display Name, then Item ID
            composition: "",                                            // Always empty
            product_long_name: ""                                       // Sales Description
        }
    ],
    update_product_identifiers: true,                                   // Based on NDC availability
    product_identifiers: [
        {
            identifier_code: "US_NDC",                                  // Always 'US_NDC'
            value: "00002614511"                                        // UOM Detail NDC
        }
    ],
    pack_size: "",                                                      // UOM Detail Pack Size
    pack_size_type_id: "5",                                             // From the Pack Size Type Map on config, keyed on Saleable Unit
    update_requirements: false,                                         // Always false
    update_packaging: false,                                            // Always false
    class_pharmaceutical__strength: "3MG",
    class_pharmaceutical__dosage_form: "POWDER",                        // Dosage Form CODE, not the internal id
    class_pharmaceutical__generic_name: "BAQSIMI 3MG PWD",
    is_leaf_product: false,                                             // True only when pack_size_type_id is '1' (the base unit)
    is_override_products_packaging_type_validation: false,              // Always false
    gtin14: "00300026145113",
    update_composition: true,                                           // True only when composition is not empty
    composition: "[{"238133c2-6039-4a0c-9a57-dd94e227e1cc":"20"}]",     // [{ base unit product UUID: Qty in Lowest Unit }]; empty on a base row
    is_bin_managed: false,                                              // Bin feature AND config Use Bins AND item Use Bins
    bin_feature_enabled: true                                           // NetSuite Bin Management feature in effect
}

# Purchase Order Create/Update
Create Endpoint: https://api.tracktraceweb.com/2.0/transactions/purchase
Update Endpoint: https://api.tracktraceweb.com/2.0/transactions/purchase/{{tran_uuid}}
Method: POST
Payload:
{
    "transaction_uuid": "f4efb87c-e483-4f31-b91c-dcfe21382bb6",
    "custom_id": "PO446",
    "location_uuid": "800930e8-1609-4b50-a8ef-929088f89a11",
    "trading_partner_uuid": "358a9c44-48c1-47a2-833d-8bf1970ad350",
    "transaction_date": "2026-09-28",
    "billing_address_uuid": "",
    "ship_from_address_uuid": "ac519f3d-0f02-46db-9b1f-5a410104f56f",
    "ship_to_address_uuid": "",
    "sold_by_address_uuid": "ac519f3d-0f02-46db-9b1f-5a410104f56f",
    "line_items": [
        {
            "product_uuid": "c427a199-a6e2-472a-9f3f-36706c00358c",
            "quantity": 1,
            "sort_order": "1"
        }
    ],
    "is_approved": true,                                                // Always true
    "is_approved_is_ship_transaction": false,                           // Always false for purchase orders
    "is_manually_close_transaction": false,
    "enforce_oci": false,                                               // Always false for purchase orders
    "order_nbr": "PO446",
    "po_nbr": "PO446"
}

# Sales Order Create/Update
Endpoint: https://api.tracktraceweb.com/2.0/transactions/sales
Method: POST
Payload:
{
      transaction_uuid: "",
      custom_id: "SO609",
      location_uuid: "57841bd1-5bd4-43cc-b5f6-17f85717a712",
      trading_partner_uuid: "b4720a62-dd54-481a-83e2-d4f6ebaf9c66",
      transaction_date: "2026-09-30",
      billing_address_uuid: "24530340-c9c8-4ade-a08d-921df2f8c903",
      ship_from_address_uuid: "",
      ship_to_address_uuid: "24530340-c9c8-4ade-a08d-921df2f8c903",
      sold_by_address_uuid: "",
      line_items: [
            {
                  "product_uuid": "431aac76-0506-4e3c-a5b1-5c16a2822f30",
                  "quantity": 1,
                  "sort_order": "1"
            }
      ],
      is_approved: true,
      is_approved_is_ship_transaction: false,
      is_manually_close_transaction: false,
      enforce_oci: false,
      order_nbr: "SO609",
      po_nbr: "SO609",
      outbound_transaction_sub_type: "SALES"
}

# Item Receipt
Endpoint: https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_jj_rl_rb_write&deploy=customdeploy_jj_rl_rb_write
Method: POST
Payload:
{
    "operation": "item_receipt",
    "request_uuid": "11111111-2222-3333-4444-555555555555",
    "order_id": "16050",
    "shipment_uuid": "",
    "scan_session_id": "POSTMAN-TEST-01",
    "transaction_date": "2026-09-30",
    "memo": "Postman test receipt for PO447",
    "lines": [
        {
            "line_unique_key": "1",
            "item_id": "718",
            "quantity": 2,
            "exception_reason": "Short stock at the bin",
            "exception_note": "One case damaged in transit",
            "inventory": [
                {
                    "lot": "LOT-718-A",
                    "expiry": "2027-12-31",
                    "quantity": 2
                }
            ]
        },
        {
            "line_unique_key": "2",
            "item_id": "719",
            "quantity": 4,
            "inventory": [
                {
                    "lot": "LOT-719-A",
                    "expiry": "2027-06-30",
                    "quantity": 3
                },
                {
                    "lot": "LOT-719-B",
                    "expiry": "2028-01-31",
                    "quantity": 1
                }
            ]
        }
    ]
}

Response:
{
    "success": true,
    "internal_id": 16453,
    "external_id": "11111111-2222-3333-4444-555555555563",
    "lines_posted": 1
}

# Item Fulfillment
Endpoint: https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_jj_rl_rb_write&deploy=customdeploy_jj_rl_rb_write
Method: POST
Payload:
{
  "operation": "item_fulfillment",
  "request_uuid": "3f8c21b6-7d94-4e52-9a10-5b6c7d8e9f01",
  "order_id": "16853",
  "shipment_uuid": "b41e9c77-2a65-4f38-85d0-9c1e2f3a4b5c",
  "transaction_date": "2026-10-05",
  "memo": "SO610 full fulfilment - Postman test",
  "lines": [
    {
      "line_unique_key": "1",
      "item_id": "718",
      "quantity": 1,
      "bin": "50",
      "inventory": [
        {
          "lot": "LOT-718-A",
          "quantity": 1
        }
      ]
    },
    {
      "line_unique_key": "2",
      "item_id": "721",
      "quantity": 1,
      "bin": "50",
      "inventory": [
        {
          "lot": "LOT-721-A",
          "quantity": 1
        }
      ]
    },
    {
      "line_unique_key": "3",
      "item_id": "719",
      "quantity": 2,
      "bin": "50",
      "inventory": [
        {
          "lot": "LOT-719-A",
          "quantity": 2
        }
      ]
    }
  ]
}

Response:
{
    "success": true,
    "internal_id": 16954,
    "external_id": "3f8c21b6-7d94-4e52-9a10-5b6c7d8e9f02",
    "lines_posted": 1,
    "exception_quantity": 0,
    "exception_lines": [],
    "shipping_status": "Shipped"
}

# PO/SO List
Endpoint: https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_jj_rl_rb_read&deploy=customdeploy_jj_rl_rb_read&operation=list_transactions&record_type=purchaseorder&location=13&page_size=50
Method: GET
record_type: 'purchaseorder' for purchase order and  'salesorder' for sales order
Response:
{
    "success": true,
    "record_type": "purchaseorder",
    "type": "Purchase",
    "list_token": "purchase",
    "location_filter": {
        "id": "13",
        "source": "parameter"
    },
    "page": {
        "offset": 0,
        "size": 50,
        "returned": 1,
        "capped": false
    },
    "has_more": false,
    "transactions": [
        {
            "internal_id": "16352",
            "record_type": "purchaseorder",
            "type": "Purchase",
            "document_number": "PO448",
            "transaction_date": "10/1/2026",
            "status": "Pending Receipt",
            "status_ref": "PurchOrd:B",
            "entity_id": "1841",
            "entity_name": "- None -",
            "location_id": "13",
            "location_name": "Test Location 1",
            "subsidiary_id": "1",
            "transaction_uuid": "d7b3794d-2feb-44ce-9340-17637aabab35",
            "shipment_uuid": "- None -",
            "open_lines": 1
        }
    ]
}

# PO/SO Detail
Endpoint: https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_jj_rl_rb_read&deploy=customdeploy_jj_rl_rb_read&operation=fetch_transaction&record_type=purchaseorder&internal_id=16352
Method: GET
record_type: 'purchaseorder' for purchase orders and 'salesorder' for sales orders
Response:
{
    "success": true,
    "internal_id": "16352",
    "record_type": "purchaseorder",
    "type": "Purchase",
    "creates": "itemreceipt",
    "document_number": "PO448",
    "transaction_date": "10/1/2026",
    "status": "Pending Receipt",
    "status_ref": "PurchOrd:B",
    "entity_id": "1841",
    "entity_name": "Test Vendor 1",
    "location_id": "13",
    "location_name": "Test Location 1",
    "subsidiary_id": "1",
    "memo": "",
    "transaction_uuid": "d7b3794d-2feb-44ce-9340-17637aabab35",
    "shipment_uuid": "",
    "default_hold_bin": "49",
    "line_count": 3,
    "lines": [
        {
            "line_unique_key": "1",
            "item_id": "718",
            "item_name": "718",
            "description": "Test Purchase Description",
            "quantity": 2,
            "quantity_remaining": 2,
            "unit": "PF",
            "unit_id": "23",
            "unit_abbreviation": "PF",
            "conversion_rate": 1,
            "is_base_unit": false,
            "quantity_in_base_units": 2,
            "remaining_in_base_units": 2,
            "requires_serialization": true,
            "is_serial_tracked": false,
            "is_lot_tracked": true,
            "uses_bins": true,
            "product_uuid": "",
            "product_uuid_missing_reason": "NO_ROW: the item has no UOM Detail row for unit \"PF\". It has: EACH, PALLET",
            "uom_unit_matched": "",
            "ndc": "",
            "gtin": "",
            "upc": "",
            "pack_size": "",
            "bin_id": "",
            "location_id": "13"
        },
        {
            "line_unique_key": "2",
            "item_id": "719",
            "item_name": "719",
            "description": "Test Purchase Description",
            "quantity": 4,
            "quantity_remaining": 4,
            "unit": "Case",
            "unit_id": "1",
            "unit_abbreviation": "CA",
            "conversion_rate": 20,
            "is_base_unit": false,
            "quantity_in_base_units": 80,
            "remaining_in_base_units": 80,
            "requires_serialization": true,
            "is_serial_tracked": false,
            "is_lot_tracked": true,
            "uses_bins": true,
            "product_uuid": "4e1fca3d-4c2a-4a4c-a77d-2cc483391d5b",
            "product_uuid_missing_reason": "",
            "uom_unit_matched": "EACH",
            "ndc": "NDC",
            "gtin": "GTIN-14",
            "upc": "UPC",
            "pack_size": "Pack Size",
            "bin_id": "",
            "location_id": "13"
        }
    ]
}

# Item Fulfillment Exception
Endpoint: https://td3113894.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=customscript_jj_rl_rb_read&deploy=customdeploy_jj_rl_rb_read&operation=fulfilment_exceptions
Method: GET
Respose:
{
    "success": true,
    "list_id": "customlist_jj_rb_fulfil_exception",
    "submit_as": "name",
    "count": 7,
    "exception_reasons": [
        {
            "id": "2",
            "name": "Damaged on inspection"
        },
        {
            "id": "3",
            "name": "Expired or short-dated"
        },
        {
            "id": "4",
            "name": "Not found at the location"
        },
        {
            "id": "7",
            "name": "Other - raise an investigation"
        },
        {
            "id": "6",
            "name": "Quantity mismatch on count"
        },
        {
            "id": "5",
            "name": "Serial mismatch"
        },
        {
            "id": "1",
            "name": "Short stock at the bin"
        }
    ]
}