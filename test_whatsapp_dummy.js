/**
 * DUMMY WhatsApp test — sends a hardcoded report payload to MSG91
 * without touching the database or live API.
 * Run: node test_whatsapp_dummy.js
 */
require("dotenv").config();
const axios = require("axios");

const AUTH_KEY = process.env.MSG91_AUTH_KEY;
const INTEGRATED_NUMBER = process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER;
const TEMPLATE_NAME = process.env.MSG91_WHATSAPP_TEMPLATE_NAME;
const TEMPLATE_NAMESPACE = process.env.MSG91_WHATSAPP_TEMPLATE_NAMESPACE;
const TEMPLATE_LANGUAGE = process.env.MSG91_WHATSAPP_TEMPLATE_LANGUAGE || "en";
const BASE_URL = (
    process.env.MSG91_WHATSAPP_BASE_URL ||
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk"
).replace(/\/+$/, "");

const TEST_PHONE = "919131042937"; // already with country code

// ── Dummy data (matches the expected message format exactly) ──────────────────
const DUMMY = {
    city: "Pune",
    date: "15 Mar 2026",
    registered: "10182",   // present + absent should equal this
    present: "1087",
    absent: "9095",
    rampPresent: "40",
    rampAbsent: "82",
    pmcPresent: "467",
    pmcAbsent: "4363",
    outsourcePresent: "494",
    outsourceAbsent: "3764",
    // body_12: template already has the word "Present" so we just send the numbers
    swachValue: "86, Absent 886",
};

const payload = {
    integrated_number: INTEGRATED_NUMBER,
    content_type: "template",
    payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
            name: TEMPLATE_NAME,
            namespace: TEMPLATE_NAMESPACE,
            language: { policy: "deterministic", code: TEMPLATE_LANGUAGE },
            to_and_components: [
                {
                    to: [TEST_PHONE],
                    components: {
                        body_1: { type: "text", value: DUMMY.city },
                        body_2: { type: "text", value: DUMMY.date },
                        body_3: { type: "text", value: DUMMY.registered },
                        body_4: { type: "text", value: DUMMY.present },
                        body_5: { type: "text", value: DUMMY.absent },
                        body_6: { type: "text", value: DUMMY.rampPresent },
                        body_7: { type: "text", value: DUMMY.rampAbsent },
                        body_8: { type: "text", value: DUMMY.pmcPresent },
                        body_9: { type: "text", value: DUMMY.pmcAbsent },
                        body_10: { type: "text", value: DUMMY.outsourcePresent },
                        body_11: { type: "text", value: DUMMY.outsourceAbsent },
                        body_12: { type: "text", value: DUMMY.swachValue },
                    },
                },
            ],
        },
    },
};

(async () => {
    console.log("==============================================");
    console.log("  DUMMY WhatsApp Test — NO DB CALL");
    console.log("==============================================");
    console.log("Sending to :", TEST_PHONE);
    console.log("");
    console.log("--- Dummy numbers being sent ---");
    console.log(`Registered : ${DUMMY.registered}`);
    console.log(`Present    : ${DUMMY.present}`);
    console.log(`Absent     : ${DUMMY.absent}`);
    console.log(`Ramp       : Present ${DUMMY.rampPresent}, Absent ${DUMMY.rampAbsent}`);
    console.log(`PMC        : Present ${DUMMY.pmcPresent}, Absent ${DUMMY.pmcAbsent}`);
    console.log(`Outsource  : Present ${DUMMY.outsourcePresent}, Absent ${DUMMY.outsourceAbsent}`);
    console.log(`Swach      : Present ${DUMMY.swachValue}`);
    console.log("");

    try {
        const resp = await axios.post(`${BASE_URL}/`, payload, {
            headers: { "Content-Type": "application/json", authkey: AUTH_KEY },
            timeout: 15000,
        });
        console.log("✅ Sent! Provider response:");
        console.log(JSON.stringify(resp.data, null, 2));
    } catch (err) {
        console.error("❌ Failed:", err.message);
        if (err.response?.data) {
            console.error("   Details:", JSON.stringify(err.response.data, null, 2));
        }
    }

    process.exit(0);
})();
