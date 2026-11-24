const parts = window.location.pathname.split("/").filter(Boolean);
const siteId = parts[1];
const slug = parts[2];
const consentKey = `sitecraft-tracking-consent-${siteId}`;
let trackingSettings;
let trackingLoaded = false;

function loadScript(src) {
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.append(script);
}

function loadTracking() {
  const settings = trackingSettings;
  if (!settings || trackingLoaded) return;
  trackingLoaded = true;

  if (settings.gtm_id) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    loadScript(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(settings.gtm_id)}`);
  }

  if (settings.ga4_id) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", settings.ga4_id);
    loadScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(settings.ga4_id)}`);
  }

  if (settings.meta_pixel_id) {
    window.fbq = function fbq() {
      window.fbq.callMethod ? window.fbq.callMethod.apply(window.fbq, arguments) : window.fbq.queue.push(arguments);
    };
    window.fbq.push = window.fbq;
    window.fbq.loaded = true;
    window.fbq.version = "2.0";
    window.fbq.queue = [];
    window._fbq = window.fbq;
    window.fbq("init", settings.meta_pixel_id);
    window.fbq("track", "PageView");
    loadScript("https://connect.facebook.net/en_US/fbevents.js");
  }

  if (settings.tiktok_pixel_id) {
    window.TiktokAnalyticsObject = "ttq";
    const ttq = window.ttq = window.ttq || [];
    ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
    ttq.setAndDefer = function setAndDefer(target, method) {
      target[method] = function deferredMethod() {
        target.push([method, ...arguments]);
      };
    };
    for (const method of ttq.methods) ttq.setAndDefer(ttq, method);
    ttq.load = function load(pixelId) {
      ttq._i = ttq._i || {};
      ttq._i[pixelId] = [];
      ttq._i[pixelId]._u = "https://analytics.tiktok.com/i18n/pixel/events.js";
      ttq._t = ttq._t || {};
      ttq._t[pixelId] = Date.now();
      loadScript(`https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(pixelId)}&lib=ttq`);
    };
    ttq.load(settings.tiktok_pixel_id);
    ttq.page();
  }
}

function saveConsent(allowed) {
  localStorage.setItem(consentKey, allowed ? "accepted" : "rejected");
  if (!allowed && trackingLoaded) {
    window.location.reload();
    return;
  }
  document.querySelector("#consent-banner").hidden = true;
  document.querySelector("#consent-settings").hidden = false;
  if (allowed) loadTracking();
}

async function loadPost() {
  try {
    const response = await fetch(`/api/public/${encodeURIComponent(siteId)}/${encodeURIComponent(slug)}`);
    if (!response.ok) throw new Error("Post not found");
    const post = await response.json();
    document.title = `${post.title} | ${post.site_name}`;
    document.querySelector("#public-site-name").textContent = post.site_name;
    document.querySelector("#public-title").textContent = post.title;
    document.querySelector("#public-date").textContent =
      post.published_at ? new Date(`${post.published_at}Z`).toLocaleDateString() : "";
    document.querySelector("#public-body").textContent = post.body;
    trackingSettings = {
      gtm_id: post.gtm_id || "",
      ga4_id: post.ga4_id || "",
      meta_pixel_id: post.meta_pixel_id || "",
      tiktok_pixel_id: post.tiktok_pixel_id || "",
    };

    const consent = localStorage.getItem(consentKey);
    if (consent === "accepted") {
      document.querySelector("#consent-settings").hidden = false;
      loadTracking();
    } else if (consent !== "rejected") {
      document.querySelector("#consent-banner").hidden = false;
    } else {
      document.querySelector("#consent-settings").hidden = false;
    }
  } catch (error) {
    document.querySelector("#public-post").hidden = true;
    document.querySelector("#public-error").textContent = error.message || "Unable to load this post.";
    document.querySelector("#public-error").hidden = false;
  }
}

document.querySelector("#consent-accept").addEventListener("click", () => saveConsent(true));
document.querySelector("#consent-reject").addEventListener("click", () => saveConsent(false));
document.querySelector("#consent-settings").addEventListener("click", () => {
  localStorage.removeItem(consentKey);
  document.querySelector("#consent-banner").hidden = false;
  document.querySelector("#consent-settings").hidden = true;
});

loadPost();
