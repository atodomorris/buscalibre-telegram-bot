const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const qs = require("qs");

// ---------------------------
// Limpieza de caracteres raros
// ---------------------------
function limpiarTexto(texto) {
  if (!texto) return texto;

  return texto
    .replace(/Â¡/g, "¡")
    .replace(/Â¿/g, "¿")
    .replace(/Ã¡/g, "á")
    .replace(/Ã©/g, "é")
    .replace(/Ã­/g, "í")
    .replace(/Ã³/g, "ó")
    .replace(/Ãº/g, "ú")
    .replace(/Ã±/g, "ñ")
    .replace(/Ã/g, "Á")
    .replace(/&iexcl;/g, "¡");
}

// ---------------------------
// Texto seguro para Telegram
// ---------------------------
function textoSeguro(texto) {
  if (!texto || !texto.trim()) {
    return "Nueva promoción disponible en Buscalibre";
  }
  return texto.toUpperCase();
}

// ---------------------------
// Variables de entorno Telegram
// ---------------------------
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("❌ ERROR: Variables TELEGRAM no definidas.");
  process.exit(1);
}

// ---------------------------
// Variables Cloudinary
// ---------------------------
const CLOUD_NAME = "dvye0cje6";
const COLOR_FONDO = "fe8d10"; // naranja

// ---------------------------
// Cloudinary: 1000x327 centrado
// ---------------------------
function cloudinaryFetch(urlOriginal) {
  if (!urlOriginal) return urlOriginal;

  return (
    `https://res.cloudinary.com/${CLOUD_NAME}/image/fetch/` +
    `c_fit,w_1000,h_327,g_center,` +
    `b_rgb:${COLOR_FONDO},` +
    `f_jpg,q_auto/` +
    encodeURIComponent(urlOriginal)
  );
}

// ---------------------------
// Envío UN SOLO mensaje (Mejorado: Negrita + Sin espacio extra)
// ---------------------------
async function enviarTelegram(promo) {
  const imagen = cloudinaryFetch(promo.imagen);

  // MODIFICACIÓN:
  // 1. Se añaden etiquetas <b> para negrita.
  // 2. Se reduce el espaciado (\n) antes de la etiqueta <a> para quitar el hueco blanco.
  const mensaje =
    `<b>🚨 NUEVA PROMO DETECTADA!</b>\n` +
    `<b>${textoSeguro(promo.texto)}</b>` +
    `<a href="${imagen}">&#8205;</a>`;

  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    qs.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mensaje,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: "🚀 Ver Ofertas", url: promo.link }
        ]]
      })
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  console.log("✅ Promo enviada (link invisible optimizado)");
}

// ---------------------------
// Scraping principal
// ---------------------------
async function buscarPromo(enviarMensajePrueba = false) {
  console.log("🔎 Buscando promo -", new Date().toLocaleString());

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  await page.goto("https://www.buscalibre.cl", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body", { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  const promo = await page.evaluate(() => {
    const img = document.querySelector("section#portadaHome img[alt]");
    const link = img?.closest("a");

    return {
      texto: img?.alt || "",
      link: link
        ? "https://www.buscalibre.cl" + link.getAttribute("href")
        : "https://www.buscalibre.cl",
      imagen: img?.src || ""
    };
  });

  promo.texto = limpiarTexto(promo.texto);

  const archivoPromo = "ultimaPromo.json";
  let ultimaPromo = null;

  if (fs.existsSync(archivoPromo)) {
    ultimaPromo = JSON.parse(fs.readFileSync(archivoPromo, "utf-8"));
  }

  if (enviarMensajePrueba) {
    console.log("📤 Enviando mensaje de prueba...");
    await enviarTelegram(promo);
  }

  if (!ultimaPromo || JSON.stringify(ultimaPromo) !== JSON.stringify(promo)) {
    if (!enviarMensajePrueba) {
      await enviarTelegram(promo);
    }
    fs.writeFileSync(archivoPromo, JSON.stringify(promo, null, 2), "utf-8");
  } else {
    console.log("ℹ️ Promo sin cambios.");
  }

  await browser.close();
}

// ---------------------------
// Primera ejecución (test)
// ---------------------------
buscarPromo(true);

// ---------------------------
// Revisión cada 1 hora
// ---------------------------
setInterval(buscarPromo, 3600000);
