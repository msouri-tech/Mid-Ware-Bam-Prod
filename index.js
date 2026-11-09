require('dotenv').config();
const express = require('express');
const axios = require('axios');
const https = require('https'); // Required for SSL bypass on Vercel

const app = express();
const port = process.env.PORT || 3000;
const shipperId = parseInt(process.env.SHIPPER_ID, 10);

app.use(express.json());

// --- Token Caching Logic ---
const tokenCache = {
  accessToken: null,
  expiresAt: 0,
  fetchPromise: null,
};

async function fetchAccessToken() {
  const tokenUrl = process.env.KEYCLOAK_TOKEN_URL;
  const params = new URLSearchParams({
    grant_type: process.env.KEYCLOAK_GRANT_TYPE,
    client_id: process.env.KEYCLOAK_CLIENT_ID,
    client_secret: process.env.KEYCLOAK_CLIENT_SECRET,
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  tokenCache.accessToken = response.data.access_token;
  tokenCache.expiresAt = Date.now() + response.data.expires_in * 1000;
  return tokenCache.accessToken;
}

async function getAccessToken() {
  const bufferMs = 60 * 1000; // Refresh 1 minute before expiry

  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + bufferMs) {
    return tokenCache.accessToken;
  }

  if (!tokenCache.fetchPromise) {
    tokenCache.fetchPromise = fetchAccessToken().finally(() => {
      tokenCache.fetchPromise = null;
    });
  }

  return tokenCache.fetchPromise;
}

// --- Logging Logic ---
async function log(message, meta = {}) {
  const token = process.env.LOGTAIL_TOKEN;
  const url = process.env.LOGTAIL_URL;

  const logEntry = {
    dt: new Date().toISOString(),
    message,
    ...meta,
  };

  console.log('[Logtail] Sending log:', JSON.stringify(logEntry));

  if (token && url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(logEntry),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error(`[Logtail] Failed to send log. Status: ${res.status}, Response: ${text}`);
      }
    } catch (error) {
      console.error('[Logtail] Failed to send log to Logtail:', error.message);
    }
  }
}

function normalizeIncomingData(body) {
  return {
    ...body,
    reference_number: body.reference_number || body.DocumentId || body.Reference,
    type: body.type || body.DeliveryStatus,
    event_time: body.event_time || body.TimeStamp || body.timestamp,
    recipient_phone: body.recipient_phone || body.Phone,
    notes: body.notes || body.Note,
  };
}

function formatTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function resolveTimestamp(data) {
  const raw = data.event_time;
  if (!raw || raw === 'YYYY-MM-DDTHH:mm:ss') {
    return { date: new Date(), usedFallback: true };
  }
  const parsed = new Date(raw);
  if (isNaN(parsed.getTime())) {
    return { date: new Date(), usedFallback: true };
  }
  return { date: parsed, usedFallback: false };
}

const GUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanPayload(payload) {
  const cleaned = { ...payload };
  if (!cleaned.id || !GUID_REGEX.test(cleaned.id.trim())) {
    delete cleaned.id;
  }
  return cleaned;
}

// --- Routes ---

app.get('/', (req, res) => {
  log("Root route hit", { route: "/", level: "info" });
  res.send('Hi! ChronoDiali API is running.');
});

async function handleBamPost(req, res) {
  const data = normalizeIncomingData(req.body);

  log("BAM incoming request", {
    route: "/BAM",
    level: "info",
    body: req.body,
    tracking_number: data.reference_number,
    event_type: data.type,
  });

  const { date: eventDate } = resolveTimestamp(data);
  const isoTimestamp = formatTimestamp(eventDate);

  if (data.reference_number === 'G12340262') {
    return res.status(200).send({ message: 'Data received and dispatched successfully' });
  }

  const createBasePayload = (overrides) => ({
    command: "UpdateStatus",
    shipper_id: shipperId,
    tracking_id: data.reference_number,
    shipper_order_ref_no: data.shipper_order_ref_no || data.customer_reference_number || "",
    timestamp: isoTimestamp,
    ...overrides
  });

  const option1 = createBasePayload({
    comments: "",
    previous_status: "",
    shipper_ref_no: "",
    status: "Arrived at Sorting Hub",
    tracking_ref_no: data.reference_number
  });

  const option2 = createBasePayload({
    shipper_order_ref_no: "",
    status: "Delivered",
    is_parcel_on_rts_leg: false,
    delivery_information: {
      state: "Received by Customer",
      left_in_safe_place: false,
      proof: {
        signature_uri: data.signature_image || "",
        image_uris: [data.poc_image || ""],
        signed_by: {
          name: " ",
          contact: data.recipient_phone || "",
          relationship: ""
        }
      }
    }
  });

  const option3 = createBasePayload({
    shipper_order_ref_no: "",
    status: "Returned to Sender",
    is_parcel_on_rts_leg: true,
    rts_reason: data.notes || "Return to sender: Nobody at address",
    delivery_information: {
      state: "",
      left_in_safe_place: false,
      proof: {
        signature_uri: data.signature_image || "",
        image_uris: [data.poc_image || ""],
        signed_by: {
          name: "Amana (RTS)",
          contact: data.recipient_phone || "",
          relationship: ""
        }
      }
    }
  });

  const option4 = createBasePayload({
    comments: "",
    previous_status: "Arrived at Sorting Hub",
    shipper_ref_no: data.reference_number,
    status: "On Vehicle for Delivery",
    tracking_ref_no: data.reference_number
  });

  const option5 = createBasePayload({
    shipper_order_ref_no: "",
    status: "Delivery Exception",
    is_parcel_on_rts_leg: false,
    delivery_information: {
      state: "Livraison erroner",
      left_in_safe_place: false,
      proof: {
        signature_uri: data.signature_image || "",
        image_uris: [data.poc_image || ""],
        signed_by: {
          name: " ",
          contact: data.recipient_phone || "",
          relationship: ""
        }
      }
    }
  });

  const option6 = createBasePayload({
    comments: "",
    previous_status: "Delivered",
    shipper_ref_no: data.reference_number,
    status: "Revert from Delivered",
    tracking_ref_no: data.reference_number
  });

  let option = {};
  
  if (data.type === "delivered") {
    option = option2;
  } else if (data.type === 'reachedathub' || data.type === "inscan_at_hub") {
    option = option1;
  } else if (data.type === "rto_delivered") {
    option = option3;
  } else if (data.type === "outfordelivery") {
    option = option4;
  } else if (data.type === 'undelivered') {
    option = option5;
  } else if (data.type === "revert_from_delivered") {
    option = option6;
  } else {
    return res.status(400).send({ message: 'Unknown event type' });
  }

  option = cleanPayload(option);
  const targetUrl = process.env.BAM_API_URL;

  try {
    const accessToken = await getAccessToken();

    const urlObj = new URL(targetUrl);
    
    const ipBasedUrl = `https://172.22.19.10${urlObj.pathname}`;

    log("BAM API request", {
      level: "info",
      url: targetUrl,
      payload: option,
      tracking_number: data.reference_number,
      event_type: data.type,
    });

    const response = await axios.post(ipBasedUrl, option, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Host: 'sibo-chronodialiapi.barid.ma' 
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: false 
      })
    });
    log("BAM API response", {
      level: "success",
      status: response.status,
      data: response.data,
      tracking_number: data.reference_number,
      event_type: data.type,
    });

    res.status(200).send({ message: 'Data received and dispatched successfully' });
  } catch (error) {
    log("BAM API response", {
      level: "error",
      status: error.response?.status,
      error: error.message,
      data: error.response?.data,
      tracking_number: data.reference_number,
      event_type: data.type,
    });
    res.status(500).send({ message: error.message });
  }
}

app.post(['/BAM', '/bam'], handleBamPost);

app.all(['/BAM', '/bam'], (req, res, next) => {
  if (req.method === 'POST') {
    return next();
  }
  res.status(405).send({ message: 'Method not allowed' });
});

app.listen(port, () => {
  log(`Server is running on port ${port}`, { level: "info", event: "server_start" });
  console.log(`Server is running on port ${port}`);
});