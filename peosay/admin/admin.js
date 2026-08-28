import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { collection, getFirestore, limit, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-functions.js";

const $ = (id) => document.getElementById(id);
const state = {
  polls: [],
  reports: [],
  sponsors: [],
  affiliates: [],
  physicalProducts: [],
  physicalOrders: [],
  games: [],
  audits: [],
  unsubscribers: []
};

function setConnection(text, kind = "") {
  $("connectionState").textContent = text;
  $("connectionState").className = `pill ${kind}`.trim();
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function safeActionError(fallback, error) {
  const code = String(error?.code || "").toLowerCase();
  if (code.includes("permission-denied")) return "Bu işlem için yönetici yetkiniz yok.";
  if (code.includes("unauthenticated")) return "Yönetici oturumu sona erdi. Yeniden giriş yapın.";
  if (code.includes("invalid-argument")) return "Girilen bilgileri kontrol edin.";
  if (code.includes("failed-precondition")) return "Bu kayıt mevcut durumunda değiştirilemez.";
  return fallback;
}

function safeAuthError(error) {
  const code = String(error?.code || "").toLowerCase();
  if (code.includes("unauthorized-domain")) {
    return "Bu GitHub alanı Firebase Authentication yetkili alanlarına henüz eklenmemiş. Yönetici onayıyla aslndrds.github.io alanı yetkilendirilmelidir.";
  }
  if (code.includes("operation-not-allowed")) return "Google ile giriş Firebase projesinde etkin değil.";
  if (code.includes("popup-blocked")) return "Tarayıcı giriş penceresini engelledi. Bu site için açılır pencereye izin verip tekrar deneyin.";
  if (code.includes("popup-closed-by-user") || code.includes("cancelled-popup-request")) return "Google girişi iptal edildi.";
  if (code.includes("network-request-failed")) return "Ağ bağlantısı nedeniyle Google girişi tamamlanamadı.";
  return "Giriş tamamlanamadı. Firebase alan yetkisini ve internet bağlantısını kontrol edin.";
}

function clearListeners() {
  state.unsubscribers.forEach((unsubscribe) => unsubscribe());
  state.unsubscribers = [];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function dateText(timestamp) {
  if (!timestamp?.toDate) return "zaman bekleniyor";
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "short", timeStyle: "short" }).format(timestamp.toDate());
}

function dateInput(timestamp, fallback) {
  const date = timestamp?.toDate ? timestamp.toDate() : fallback;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function renderPolls() {
  const list = $("pollList");
  list.replaceChildren();
  const sorted = [...state.polls].sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
  $("pollCount").textContent = `${sorted.length} kayıt`;
  $("publishedCount").textContent = String(sorted.filter((poll) => poll.status === "published").length);
  $("totalVoteCount").textContent = sorted.reduce((sum, poll) => sum + (Number(poll.totalVotes) || 0), 0).toLocaleString("tr-TR");
  if (!sorted.length) {
    list.className = "list empty";
    list.textContent = "Henüz anket yok.";
    return;
  }
  list.className = "list";
  sorted.forEach((poll) => {
    const row = element("article", "list-row");
    const copy = element("div");
    const title = element("strong", "", poll.question || "Adsız anket");
    const meta = element("div", "meta");
    const status = element("span", "status", poll.status || "draft");
    meta.append(status, document.createTextNode(`${poll.category || "Kategori yok"} • ${Number(poll.totalVotes) || 0} oy • ${dateText(poll.updatedAt)}`));
    copy.append(title, meta);
    const actions = element("div", "row-actions");
    const edit = element("button", "small-button", "Düzenle");
    edit.type = "button";
    edit.addEventListener("click", () => openPollDialog(poll));
    actions.append(edit);
    row.append(copy, actions);
    list.append(row);
  });
}

function renderReports(resolveReport) {
  const list = $("reportList");
  list.replaceChildren();
  $("pendingReportCount").textContent = String(state.reports.length);
  const now = Date.now();
  const fallbackHours = {unsafe: 4, rights: 24, spam: 48};
  const dueMs = (report) => report.dueAt?.toDate?.().getTime()
    ?? ((report.createdAt?.toDate?.().getTime() ?? now) + (fallbackHours[report.reason] || 48) * 3_600_000);
  const overdue = state.reports.filter((report) => dueMs(report) < now).length;
  $("overdueReportCount").textContent = String(overdue);
  if (!state.reports.length) {
    list.className = "list empty";
    list.textContent = "Bekleyen rapor yok.";
    return;
  }
  list.className = "list";
  const priorities = {critical: 0, high: 1, normal: 2};
  [...state.reports].sort((a, b) => {
    const overdueOrder = Number(dueMs(b) < now) - Number(dueMs(a) < now);
    return overdueOrder || (priorities[a.priority] ?? 3) - (priorities[b.priority] ?? 3) || dueMs(a) - dueMs(b);
  }).forEach((report) => {
    const row = element("article", "list-row");
    const copy = element("div");
    const remainingMs = dueMs(report) - now;
    const slaText = remainingMs < 0
      ? `${Math.max(1, Math.ceil(Math.abs(remainingMs) / 3_600_000))} saat gecikti`
      : `${Math.max(1, Math.ceil(remainingMs / 3_600_000))} saat kaldı`;
    copy.append(
      element("strong", "", report.reason || "Sebep belirtilmedi"),
      element("div", "meta", `${String(report.priority || "normal").toUpperCase()} • ${slaText} • Rapor: ${report.id}`)
    );
    const actions = element("div", "row-actions");
    for (const [resolution, label] of [["resolved", "Çözüldü"], ["dismissed", "Reddet"]]) {
      const button = element("button", `small-button ${resolution === "dismissed" ? "danger" : ""}`, label);
      button.type = "button";
      button.addEventListener("click", () => {
        const note = window.prompt("İsteğe bağlı kısa moderasyon notu:", "");
        if (note !== null) resolveReport(report.id, resolution, button, note);
      });
      actions.append(button);
    }
    row.append(copy, actions);
    list.append(row);
  });
}

function localizedValue(value, locale) {
  if (!value || typeof value !== "object") return "";
  return String(value[locale] || value.en || value.tr || Object.values(value)[0] || "");
}

function renderGames(openEditor) {
  const list = $("gameDefinitionList");
  list.replaceChildren();
  const sorted = [...state.games].sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
  $("gameDefinitionCount").textContent = `${sorted.length} kayıt`;
  $("publishedGameCount").textContent = String(sorted.filter((game) => game.status === "published").length);
  if (!sorted.length) {
    list.className = "list empty";
    list.textContent = "Henüz merkezi oyun sürümü yok.";
    return;
  }
  list.className = "list";
  sorted.forEach((game) => {
    const row = element("article", "list-row");
    const copy = element("div");
    const status = element("span", "status", game.status || "draft");
    const meta = element("div", "meta");
    meta.append(status, document.createTextNode(`${game.kind || "?"} • ${game.cadence || "?"} • v${game.version || 1} • ${(game.countryCodes || []).join(", ") || "GLOBAL"}`));
    copy.append(element("strong", "", localizedValue(game.title, "tr") || game.id), meta);
    const actions = element("div", "row-actions");
    const edit = element("button", "small-button", game.status === "published" ? "İncele / arşivle" : "Düzenle");
    edit.type = "button";
    edit.addEventListener("click", () => openEditor(game.id));
    actions.append(edit);
    row.append(copy, actions);
    list.append(row);
  });
}

const quizTemplate = [{
  prompt: {tr: "Soru metni", en: "Question text"},
  options: [
    {id: "a", label: {tr: "Birinci seçenek", en: "First option"}},
    {id: "b", label: {tr: "İkinci seçenek", en: "Second option"}}
  ],
  correctOptionId: "a"
}];

function setRotationAvailability() {
  const rotating = $("gameCadence").value !== "once";
  $("gameRotationIndex").disabled = !rotating;
  $("gameRotationSize").disabled = !rotating;
}

function populateGameDialog(game = null) {
  $("gameDialogTitle").textContent = game ? "Oyun sürümünü düzenle" : "Yeni oyun sürümü";
  $("gameId").value = game?.gameId || "";
  $("gameId").readOnly = Boolean(game);
  $("gameVersion").value = game?.version || 1;
  $("gameStatus").value = game?.status || "draft";
  $("gameKind").value = game?.kind || "quiz";
  $("gameCadence").value = game?.cadence || "once";
  $("gameCategory").value = game?.categoryKey || "general";
  $("gameTitleTr").value = localizedValue(game?.title, "tr");
  $("gameTitleEn").value = localizedValue(game?.title, "en");
  $("gameSubtitleTr").value = localizedValue(game?.subtitle, "tr");
  $("gameSubtitleEn").value = localizedValue(game?.subtitle, "en");
  $("gameCountries").value = (game?.countryCodes || []).join(", ");
  $("gamePoints").value = game?.pointsPerAnswer ?? 5;
  $("gameBonus").value = game?.completionBonus ?? 5;
  $("gameRotationIndex").value = game?.rotationIndex ?? 0;
  $("gameRotationSize").value = game?.rotationSize ?? 1;
  $("gameContent").value = JSON.stringify(game?.kind === "word" ? (game.word || {
    clue: {tr: "Kelime ipucu", en: "Word clue"}, answer: "CEVAP"
  }) : (game?.questions || quizTemplate), null, 2);
  $("gameFormError").textContent = "";
  setRotationAvailability();
  $("gameDialog").showModal();
}

function renderAudits() {
  const list = $("auditList");
  list.replaceChildren();
  $("auditCount").textContent = String(state.audits.length);
  if (!state.audits.length) {
    list.className = "list empty";
    list.textContent = "Henüz yönetim işlemi yok.";
    return;
  }
  list.className = "list";
  state.audits
    .sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0))
    .slice(0, 30)
    .forEach((audit) => {
      const row = element("article", "list-row");
      row.append(element("strong", "", audit.action || "işlem"), element("div", "meta", `${audit.targetType || "kayıt"}: ${audit.targetId || "—"} • ${dateText(audit.createdAt)}`));
      list.append(row);
    });
}

function renderSponsors() {
  const list = $("sponsorList");
  list.replaceChildren();
  const sorted = [...state.sponsors].sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
  $("sponsorCount").textContent = `${sorted.length} kayıt`;
  $("activeSponsorCount").textContent = String(sorted.filter((campaign) => campaign.status === "active").length);
  if (!sorted.length) {
    list.className = "list empty";
    list.textContent = "Henüz sponsor kampanyası yok.";
    return;
  }
  list.className = "list";
  sorted.forEach((campaign) => {
    const row = element("article", "list-row");
    const copy = element("div");
    const title = element("strong", "", campaign.title || "Adsız kampanya");
    const meta = element("div", "meta");
    const status = element("span", "status", campaign.status || "draft");
    const remaining = Number(campaign.remainingPoints) || 0;
    const currency = campaign.currency === "reward" ? "Ödül Puanı" : "XP";
    meta.append(
      status,
      document.createTextNode(`${campaign.sponsorName || "Sponsor yok"} • `),
      element("span", "budget", `${remaining.toLocaleString("tr-TR")} ${currency} kaldı`),
      document.createTextNode(` • ${dateText(campaign.endsAt)}`)
    );
    copy.append(title, meta, element("div", "meta", campaign.disclosure || "Sponsor açıklaması eksik"));
    const actions = element("div", "row-actions");
    const edit = element("button", "small-button", "Düzenle");
    edit.type = "button";
    edit.addEventListener("click", () => openSponsorDialog(campaign));
    actions.append(edit);
    row.append(copy, actions);
    list.append(row);
  });
}

function renderAffiliates() {
  const list = $("affiliateList");
  list.replaceChildren();
  const sorted = [...state.affiliates].sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
  $("affiliateCount").textContent = `${sorted.length} kayıt`;
  $("activeAffiliateCount").textContent = String(sorted.filter((offer) => offer.status === "active").length);
  if (!sorted.length) {
    list.className = "list empty";
    list.textContent = "Henüz satış ortaklığı teklifi yok.";
    return;
  }
  list.className = "list";
  sorted.forEach((offer) => {
    const row = element("article", "list-row");
    const copy = element("div");
    const title = element("strong", "", offer.title || "Adsız teklif");
    const meta = element("div", "meta");
    meta.append(
      element("span", "status", offer.status || "draft"),
      document.createTextNode(`${offer.merchantName || "Satıcı yok"} • ${offer.destinationHost || "alan adı yok"} • ${dateText(offer.endsAt)}`)
    );
    copy.append(title, meta, element("div", "meta", offer.disclosureTr || "Komisyon bildirimi sunucu tarafından eklenecek"));
    const actions = element("div", "row-actions");
    const edit = element("button", "small-button", "Düzenle");
    edit.type = "button";
    edit.addEventListener("click", () => openAffiliateDialog(offer));
    actions.append(edit);
    row.append(copy, actions);
    list.append(row);
  });
}

function openPhysicalProductDialog(product = null) {
  $("physicalProductDialogTitle").textContent = product ? "Ürün taslağını düzenle" : "Yeni ürün taslağı";
  $("physicalProductId").value = product?.id || "";
  $("physicalProductTitle").value = product?.title || "";
  $("physicalProductStatus").value = product?.status || "draft";
  $("physicalProductDescription").value = product?.description || "";
  $("physicalProductImageUrl").value = product?.imageUrl || "";
  $("physicalProductPrice").value = product?.rewardPointPrice || 1000;
  $("physicalProductStock").value = Number(product?.stockAvailable) || 0;
  $("physicalProductLimit").value = product?.perUserLimit || 1;
  $("physicalProductCountries").value = (product?.countryCodes || ["TR"]).join(", ");
  $("physicalProductFormError").textContent = "";
  $("physicalProductDialog").showModal();
}

function renderPhysicalProducts() {
  const list = $("physicalProductList");
  list.replaceChildren();
  const sorted = [...state.physicalProducts].sort((a, b) => (b.updatedAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? 0));
  $("physicalProductListCount").textContent = `${sorted.length} kayıt`;
  $("physicalProductCount").textContent = String(sorted.filter((product) => product.status === "draft").length);
  if (!sorted.length) {
    list.className = "list empty";
    list.textContent = "Henüz fiziksel ürün taslağı yok.";
    return;
  }
  list.className = "list";
  sorted.forEach((product) => {
    const row = element("article", "list-row");
    const copy = element("div");
    const meta = element("div", "meta");
    meta.append(
      element("span", "status", product.status || "draft"),
      document.createTextNode(`${Number(product.rewardPointPrice) || 0} Ödül Puanı • satılabilir ${Number(product.stockAvailable) || 0} • ayrılmış ${Number(product.stockReserved) || 0} • gönderimde ${Number(product.stockCommitted) || 0}`)
    );
    copy.append(element("strong", "", product.title || "Adsız ürün"), meta);
    const edit = element("button", "small-button", "Düzenle");
    edit.type = "button";
    edit.addEventListener("click", () => openPhysicalProductDialog(product));
    row.append(copy, edit);
    list.append(row);
  });
}

function shippingDetailsView(details) {
  const view = $("shippingDetailsView");
  view.replaceChildren();
  const fields = [
    ["Ad soyad", details.fullName], ["Telefon", details.phoneE164],
    ["Adres", details.addressLine1], ["Adres devamı", details.addressLine2],
    ["İlçe", details.district], ["Şehir", details.city],
    ["Posta kodu", details.postalCode], ["Ülke", details.countryCode]
  ];
  fields.filter(([, value]) => value).forEach(([label, value]) => {
    const row = element("div", "address-row");
    row.append(element("span", "", label), element("strong", "", value));
    view.append(row);
  });
}

function orderButton(label, action, danger = false) {
  const button = element("button", `small-button ${danger ? "danger" : ""}`.trim(), label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await action(); }
    finally { button.disabled = false; }
  });
  return button;
}

function renderPhysicalOrders(actions) {
  const list = $("physicalOrderList");
  list.replaceChildren();
  const sorted = [...state.physicalOrders].sort((a, b) => (b.updatedAt?.seconds ?? b.createdAt?.seconds ?? 0) - (a.updatedAt?.seconds ?? a.createdAt?.seconds ?? 0));
  $("physicalOrderListCount").textContent = `${sorted.length} kayıt`;
  const terminal = new Set(["canceled", "delivered", "returned_refunded"]);
  $("physicalOrderCount").textContent = String(sorted.filter((order) => !terminal.has(order.status)).length);
  if (!sorted.length) {
    list.className = "list empty";
    list.textContent = "Henüz fiziksel sipariş yok.";
    return;
  }
  list.className = "list";
  sorted.forEach((order) => {
    const row = element("article", "list-row order-row");
    const copy = element("div");
    const meta = element("div", "meta");
    meta.append(element("span", "status", order.status || "unknown"), document.createTextNode(`${order.productId || "ürün yok"} • ${Number(order.rewardPointPrice) || 0} puan • ${order.countryCode || "—"} • ${dateText(order.updatedAt || order.createdAt)}`));
    copy.append(element("strong", "", `Sipariş ${order.id}`), meta);
    const buttons = element("div", "row-actions order-actions");
    if (order.shippingDataPresent) buttons.append(orderButton("Gönderim adresini aç", () => actions.readAddress(order.id)));
    if (order.status === "pending_review") {
      buttons.append(orderButton("Onayla", () => actions.approve(order.id)));
      buttons.append(orderButton("Reddet ve puanı bırak", () => actions.reject(order.id), true));
    }
    if (order.status === "preparing") buttons.append(orderButton("Kargola", () => actions.openShipment(order.id)));
    if (order.status === "shipped") buttons.append(orderButton("Teslim edildi", () => actions.deliver(order.id)));
    if (order.status === "return_requested") buttons.append(orderButton("İadeyi incele ve puanı geri ver", () => actions.refund(order.id), true));
    row.append(copy, buttons);
    list.append(row);
  });
}

function openPollDialog(poll = null) {
  $("dialogTitle").textContent = poll ? "Anketi düzenle" : "Yeni anket";
  $("pollId").value = poll?.id || "";
  $("question").value = poll?.question || "";
  $("category").value = poll?.category || "";
  $("status").value = poll?.status || "draft";
  $("scope").value = poll?.scope || "global";
  $("countryCode").value = poll?.countryCode || "";
  $("languageCode").value = poll?.languageCode || "tr";
  $("countryCode").disabled = $("scope").value !== "country";
  $("methodology").value = poll?.methodology || "";
  $("options").value = (poll?.options || []).map((option) => `${option.id} | ${option.label}`).join("\n");
  $("formError").textContent = "";
  $("pollDialog").showModal();
}

function parseOptions(value) {
  const options = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const separator = line.indexOf("|");
    if (separator < 1) throw new Error(`${index + 1}. seçenek “kimlik | görünen ad” biçiminde olmalı.`);
    return { id: line.slice(0, separator).trim(), label: line.slice(separator + 1).trim() };
  });
  if (options.length < 2 || options.length > 8) throw new Error("2 ile 8 arasında seçenek girin.");
  return options;
}

function openSponsorDialog(campaign = null) {
  const now = new Date();
  const nextMonth = new Date(now.getTime() + 30 * 86_400_000);
  $("sponsorDialogTitle").textContent = campaign ? "Kampanyayı düzenle" : "Yeni kampanya";
  $("campaignId").value = campaign?.id || "";
  $("sponsorName").value = campaign?.sponsorName || "";
  $("sponsorTitle").value = campaign?.title || "";
  $("sponsorDisclosure").value = campaign?.disclosure || "";
  $("sponsorStatus").value = campaign?.status || "draft";
  $("sponsorCurrency").value = campaign?.currency || "xp";
  $("pointsPerClaim").value = campaign?.pointsPerClaim || 3;
  $("totalBudgetPoints").value = campaign?.totalBudgetPoints || 300;
  $("sponsorStartsAt").value = dateInput(campaign?.startsAt, now);
  $("sponsorEndsAt").value = dateInput(campaign?.endsAt, nextMonth);
  $("sponsorCountries").value = (campaign?.countryCodes || []).join(", ");
  $("sponsorTermsUrl").value = campaign?.termsUrl || "";
  $("sponsorFormError").textContent = "";
  $("sponsorDialog").showModal();
}

function openAffiliateDialog(offer = null) {
  const now = new Date();
  const nextMonth = new Date(now.getTime() + 30 * 86_400_000);
  $("affiliateDialogTitle").textContent = offer ? "Teklifi düzenle" : "Yeni teklif";
  $("affiliateOfferId").value = offer?.id || "";
  $("affiliateMerchant").value = offer?.merchantName || "";
  $("affiliateStatus").value = offer?.status || "draft";
  $("affiliateKind").value = offer?.offerKind || "physical_goods";
  $("affiliateTitle").value = offer?.title || "";
  $("affiliateDescription").value = offer?.description || "";
  $("affiliateUrl").value = offer?.destinationUrl || "";
  $("affiliateStartsAt").value = dateInput(offer?.startsAt, now);
  $("affiliateEndsAt").value = dateInput(offer?.endsAt, nextMonth);
  $("affiliateCountries").value = (offer?.countryCodes || []).join(", ");
  $("affiliateFormError").textContent = "";
  $("affiliateDialog").showModal();
}

async function start() {
  let firebaseConfig;
  try {
    const response = await fetch("./firebase-config.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    firebaseConfig = await response.json();
  } catch {
    setConnection("Firebase yapılandırması eksik", "warning");
    $("setupMessage").textContent = "firebase-config.json bulunamadı. Bu yapılana kadar panel hiçbir veriye bağlanmaz.";
    return;
  }
  if (!firebaseConfig?.apiKey || firebaseConfig.projectId !== "topora-mvp") {
    setConnection("Firebase yapılandırması geçersiz", "warning");
    $("setupMessage").textContent = "Firebase Web uygulaması değerleri henüz eklenmemiş.";
    return;
  }

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "europe-west1");
  const savePoll = httpsCallable(functions, "adminUpsertPoll");
  const resolveReportCall = httpsCallable(functions, "adminResolveReport");
  const claimInitialAdmin = httpsCallable(functions, "claimInitialAdmin");
  const seedTurkeyPolls = httpsCallable(functions, "adminSeedTurkeyPolls");
  const saveSponsorCampaign = httpsCallable(functions, "adminUpsertSponsorCampaign");
  const saveAffiliateOffer = httpsCallable(functions, "adminUpsertAffiliateOffer");
  const savePhysicalProduct = httpsCallable(functions, "adminUpsertPhysicalProduct");
  const saveGameDefinition = httpsCallable(functions, "adminUpsertGameDefinition");
  const readGameDefinition = httpsCallable(functions, "adminReadGameDefinition");
  const approvePhysicalOrder = httpsCallable(functions, "adminApprovePhysicalOrder");
  const rejectPhysicalOrder = httpsCallable(functions, "adminRejectPhysicalOrder");
  const shipPhysicalOrder = httpsCallable(functions, "adminShipPhysicalOrder");
  const deliverPhysicalOrder = httpsCallable(functions, "adminDeliverPhysicalOrder");
  const refundPhysicalReturn = httpsCallable(functions, "adminRefundPhysicalReturn");
  const readPhysicalShipping = httpsCallable(functions, "adminReadPhysicalShippingDetails");

  $("signInButton").hidden = false;
  $("signInButton").addEventListener("click", async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (error) {
      const message = safeAuthError(error);
      if (String(error?.code || "").toLowerCase().includes("unauthorized-domain")) {
        setConnection("Firebase alan yetkisi gerekli", "danger");
        $("setupMessage").textContent = message;
      }
      showToast(message);
    }
  });
  $("signOutButton").addEventListener("click", () => signOut(auth));
  $("newPollButton").addEventListener("click", () => openPollDialog());
  $("newSponsorButton").addEventListener("click", () => openSponsorDialog());
  $("newAffiliateButton").addEventListener("click", () => openAffiliateDialog());
  $("newPhysicalProductButton").addEventListener("click", () => openPhysicalProductDialog());
  $("newGameButton").addEventListener("click", () => populateGameDialog());
  $("seedTurkeyButton").addEventListener("click", async () => {
    if (!window.confirm("İncelenen Türkiye başlangıç kataloğu yayımlansın mı? Var olan anketler ve oylar değiştirilmeyecek.")) return;
    const button = $("seedTurkeyButton");
    button.disabled = true;
    try {
      const result = await seedTurkeyPolls({ confirmation: "SEED_TR_V1" });
      const data = result.data || {};
      showToast(`${data.created || 0} anket eklendi, ${data.skipped || 0} mevcut kayıt korundu.`);
    } catch (error) {
      showToast(safeActionError("Türkiye kataloğu eklenemedi. Lütfen tekrar deneyin.", error));
    } finally {
      button.disabled = false;
    }
  });
  $("cancelPollButton").addEventListener("click", () => $("pollDialog").close());
  $("closePollButton")?.addEventListener("click", () => $("pollDialog").close());
  $("cancelSponsorButton").addEventListener("click", () => $("sponsorDialog").close());
  $("closeSponsorButton")?.addEventListener("click", () => $("sponsorDialog").close());
  $("cancelAffiliateButton").addEventListener("click", () => $("affiliateDialog").close());
  $("closeAffiliateButton")?.addEventListener("click", () => $("affiliateDialog").close());
  $("cancelPhysicalProductButton").addEventListener("click", () => $("physicalProductDialog").close());
  $("closePhysicalProductButton")?.addEventListener("click", () => $("physicalProductDialog").close());
  $("cancelGameButton").addEventListener("click", () => $("gameDialog").close());
  $("closeGameButton")?.addEventListener("click", () => $("gameDialog").close());
  $("gameCadence").addEventListener("change", setRotationAvailability);
  $("gameKind").addEventListener("change", () => {
    $("gameContent").value = JSON.stringify($("gameKind").value === "word" ? {
      clue: {tr: "Kelime ipucu", en: "Word clue"}, answer: "CEVAP"
    } : quizTemplate, null, 2);
  });
  $("cancelShipmentButton").addEventListener("click", () => $("shipmentDialog").close());
  $("closeShipmentButton")?.addEventListener("click", () => $("shipmentDialog").close());
  $("closeShippingDetailsButton")?.addEventListener("click", () => $("shippingDetailsDialog").close());
  $("scope").addEventListener("change", () => {
    $("countryCode").disabled = $("scope").value !== "country";
    if ($("scope").value !== "country") $("countryCode").value = "";
  });

  async function resolveReport(id, resolution, button, resolutionNote = "") {
    button.disabled = true;
    try {
      await resolveReportCall({ reportId: id, resolution, resolutionNote });
      showToast("Rapor güncellendi.");
    } catch (error) {
      showToast(safeActionError("Rapor güncellenemedi. Lütfen tekrar deneyin.", error));
      button.disabled = false;
    }
  }

  async function openGameEditor(gameId) {
    try {
      const result = await readGameDefinition({gameId});
      populateGameDialog(result.data || null);
    } catch (error) {
      showToast(safeActionError("Oyun sürümü güvenli biçimde açılamadı.", error));
    }
  }

  const physicalOrderActions = {
    async readAddress(orderId) {
      if (!window.confirm("Bu siparişin şifreli adresi yalnız kargo hazırlığı amacıyla açılsın mı? Erişim denetim kaydına yazılacaktır.")) return;
      try {
        const result = await readPhysicalShipping({orderId, purpose: "fulfillment"});
        shippingDetailsView(result.data?.details || {});
        $("shippingDetailsDialog").showModal();
      } catch (error) {
        showToast(safeActionError("Gönderim adresi güvenli biçimde açılamadı.", error));
      }
    },
    async approve(orderId) {
      if (!window.confirm("Ayrılmış puan ve stok kesinleştirilsin, sipariş hazırlamaya alınsın mı?")) return;
      try { await approvePhysicalOrder({orderId}); showToast("Sipariş hazırlamaya alındı."); }
      catch (error) { showToast(safeActionError("Sipariş onaylanamadı.", error)); }
    },
    async reject(orderId) {
      if (!window.confirm("Sipariş reddedilsin; ayrılmış puan ve stok kullanıcıya bırakılsın mı?")) return;
      try { await rejectPhysicalOrder({orderId}); showToast("Sipariş reddedildi; puan ve stok bırakıldı."); }
      catch (error) { showToast(safeActionError("Sipariş reddedilemedi.", error)); }
    },
    openShipment(orderId) {
      $("shipmentOrderId").value = orderId;
      $("carrierName").value = "";
      $("trackingCode").value = "";
      $("trackingUrl").value = "";
      $("shipmentFormError").textContent = "";
      $("shipmentDialog").showModal();
    },
    async deliver(orderId) {
      if (!window.confirm("Taşıyıcı bilgisinden teslimat doğrulandı mı? Sipariş teslim edildi olarak işaretlensin mi?")) return;
      try { await deliverPhysicalOrder({orderId}); showToast("Sipariş teslim edildi olarak kaydedildi."); }
      catch (error) { showToast(safeActionError("Teslimat kaydedilemedi.", error)); }
    },
    async refund(orderId) {
      if (!window.confirm("İade edilen ürün incelendi mi? Ödül Puanı bir kez geri verilecek ve ürün stoğu karantinaya alınacaktır.")) return;
      try { await refundPhysicalReturn({orderId}); showToast("İade puanı geri verildi; ürün karantina stoğuna alındı."); }
      catch (error) { showToast(safeActionError("İade tamamlanamadı.", error)); }
    }
  };

  $("pollForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("formError").textContent = "";
    try {
      await savePoll({
        pollId: $("pollId").value || null,
        question: $("question").value,
        category: $("category").value,
        status: $("status").value,
        scope: $("scope").value,
        countryCode: $("countryCode").value,
        languageCode: $("languageCode").value,
        methodology: $("methodology").value,
        options: parseOptions($("options").value)
      });
      $("pollDialog").close();
      showToast("Anket ve denetim kaydı güvenli biçimde kaydedildi.");
    } catch (error) {
      $("formError").textContent = safeActionError("Anket kaydedilemedi. Lütfen tekrar deneyin.", error);
    } finally {
      submit.disabled = false;
    }
  });

  $("sponsorForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("sponsorFormError").textContent = "";
    try {
      const startsAtMs = new Date($("sponsorStartsAt").value).getTime();
      const endsAtMs = new Date($("sponsorEndsAt").value).getTime();
      const countryCodes = $("sponsorCountries").value.split(",").map((value) => value.trim()).filter(Boolean);
      await saveSponsorCampaign({
        campaignId: $("campaignId").value || null,
        sponsorName: $("sponsorName").value,
        title: $("sponsorTitle").value,
        disclosure: $("sponsorDisclosure").value,
        status: $("sponsorStatus").value,
        currency: $("sponsorCurrency").value,
        pointsPerClaim: Number($("pointsPerClaim").value),
        totalBudgetPoints: Number($("totalBudgetPoints").value),
        startsAtMs,
        endsAtMs,
        countryCodes,
        termsUrl: $("sponsorTermsUrl").value
      });
      $("sponsorDialog").close();
      showToast("Sponsor kampanyası ve denetim kaydı güvenli biçimde kaydedildi.");
    } catch (error) {
      $("sponsorFormError").textContent = safeActionError("Sponsor kampanyası kaydedilemedi.", error);
    } finally {
      submit.disabled = false;
    }
  });

  $("affiliateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("affiliateFormError").textContent = "";
    try {
      const startsAtMs = new Date($("affiliateStartsAt").value).getTime();
      const endsAtMs = new Date($("affiliateEndsAt").value).getTime();
      const countryCodes = $("affiliateCountries").value.split(",").map((value) => value.trim()).filter(Boolean);
      await saveAffiliateOffer({
        offerId: $("affiliateOfferId").value || null,
        merchantName: $("affiliateMerchant").value,
        status: $("affiliateStatus").value,
        offerKind: $("affiliateKind").value,
        title: $("affiliateTitle").value,
        description: $("affiliateDescription").value,
        destinationUrl: $("affiliateUrl").value,
        startsAtMs,
        endsAtMs,
        countryCodes
      });
      $("affiliateDialog").close();
      showToast("Satış ortaklığı teklifi ve komisyon açıklaması kaydedildi.");
    } catch (error) {
      $("affiliateFormError").textContent = safeActionError("Satış ortaklığı teklifi kaydedilemedi.", error);
    } finally {
      submit.disabled = false;
    }
  });

  $("physicalProductForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("physicalProductFormError").textContent = "";
    try {
      const countryCodes = $("physicalProductCountries").value.split(",").map((value) => value.trim()).filter(Boolean);
      await savePhysicalProduct({
        productId: $("physicalProductId").value || null,
        title: $("physicalProductTitle").value,
        status: $("physicalProductStatus").value,
        description: $("physicalProductDescription").value,
        imageUrl: $("physicalProductImageUrl").value,
        rewardPointPrice: Number($("physicalProductPrice").value),
        stockAvailable: Number($("physicalProductStock").value),
        perUserLimit: Number($("physicalProductLimit").value),
        countryCodes
      });
      $("physicalProductDialog").close();
      showToast("Fiziksel ürün ve stok taslağı kaydedildi.");
    } catch (error) {
      $("physicalProductFormError").textContent = safeActionError("Fiziksel ürün kaydedilemedi.", error);
    } finally {
      submit.disabled = false;
    }
  });

  $("gameForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("gameFormError").textContent = "";
    try {
      const kind = $("gameKind").value;
      const cadence = $("gameCadence").value;
      const content = JSON.parse($("gameContent").value);
      const countryCodes = $("gameCountries").value.split(",").map((value) => value.trim()).filter(Boolean);
      const payload = {
        gameId: $("gameId").value,
        version: Number($("gameVersion").value),
        status: $("gameStatus").value,
        kind,
        cadence,
        categoryKey: $("gameCategory").value,
        title: {tr: $("gameTitleTr").value, en: $("gameTitleEn").value},
        subtitle: {tr: $("gameSubtitleTr").value, en: $("gameSubtitleEn").value},
        countryCodes,
        pointsPerAnswer: Number($("gamePoints").value),
        completionBonus: Number($("gameBonus").value),
        rotationIndex: cadence === "once" ? null : Number($("gameRotationIndex").value),
        rotationSize: cadence === "once" ? null : Number($("gameRotationSize").value),
        questions: kind === "quiz" ? content : null,
        word: kind === "word" ? content : null
      };
      if (payload.status === "published" && !window.confirm("Bu oyun sürümü yayımlandıktan sonra içerik ve XP oranı kilitlenecek. Yayımlansın mı?")) return;
      await saveGameDefinition(payload);
      $("gameDialog").close();
      showToast("Oyun sürümü ve özel cevap anahtarı güvenli biçimde kaydedildi.");
    } catch (error) {
      if (error instanceof SyntaxError) $("gameFormError").textContent = "İçerik JSON biçimini kontrol edin.";
      else $("gameFormError").textContent = safeActionError("Oyun sürümü kaydedilemedi.", error);
    } finally {
      submit.disabled = false;
    }
  });

  $("shipmentForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    $("shipmentFormError").textContent = "";
    try {
      await shipPhysicalOrder({
        orderId: $("shipmentOrderId").value,
        carrierName: $("carrierName").value,
        trackingCode: $("trackingCode").value,
        trackingUrl: $("trackingUrl").value
      });
      $("shipmentDialog").close();
      showToast("Kargo bilgisi denetimli biçimde kaydedildi.");
    } catch (error) {
      $("shipmentFormError").textContent = safeActionError("Kargo bilgisi kaydedilemedi.", error);
    } finally {
      submit.disabled = false;
    }
  });

  onAuthStateChanged(auth, async (user) => {
    clearListeners();
    $("dashboard").hidden = true;
    $("deniedPanel").hidden = true;
    $("setupPanel").hidden = false;
    $("signInButton").hidden = Boolean(user);
    $("signOutButton").hidden = !user;
    if (!user) {
      setConnection("Yönetici girişi gerekli", "warning");
      $("setupMessage").textContent = "Google hesabınızla giriş yapın. Arayüz yalnızca sunucu tarafında atanmış yönetici yetkisi doğrulanırsa açılır.";
      return;
    }
    let token = await user.getIdTokenResult(true);
    if (token.claims.admin !== true) {
      try {
        await claimInitialAdmin();
        token = await user.getIdTokenResult(true);
      } catch {
        setConnection("Yetkisiz hesap", "danger");
        $("setupPanel").hidden = true;
        $("deniedPanel").hidden = false;
        return;
      }
    }

    setConnection("Güvenli bağlantı");
    $("setupPanel").hidden = true;
    $("dashboard").hidden = false;
    const listenError = (error) => {
      console.error(error);
      setConnection("Veri bağlantısı hatası", "danger");
      showToast("Canlı veri alınamadı. Yetki ve indeksleri kontrol edin.");
    };
    state.unsubscribers.push(
      onSnapshot(query(collection(db, "polls"), limit(100)), (snapshot) => {
        state.polls = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderPolls();
      }, listenError),
      onSnapshot(query(collection(db, "reports"), where("status", "==", "pending"), limit(50)), (snapshot) => {
        state.reports = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderReports(resolveReport);
      }, listenError),
      onSnapshot(query(collection(db, "adminAudit"), limit(50)), (snapshot) => {
        state.audits = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderAudits();
      }, listenError),
      onSnapshot(query(collection(db, "sponsorCampaigns"), limit(100)), (snapshot) => {
        state.sponsors = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderSponsors();
      }, listenError),
      onSnapshot(query(collection(db, "affiliateOffers"), limit(100)), (snapshot) => {
        state.affiliates = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderAffiliates();
      }, listenError),
      onSnapshot(query(collection(db, "physicalProducts"), limit(100)), (snapshot) => {
        state.physicalProducts = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderPhysicalProducts();
      }, listenError),
      onSnapshot(query(collection(db, "physicalOrders"), limit(100)), (snapshot) => {
        state.physicalOrders = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderPhysicalOrders(physicalOrderActions);
      }, listenError),
      onSnapshot(query(collection(db, "gameDefinitions"), limit(100)), (snapshot) => {
        state.games = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        renderGames(openGameEditor);
      }, listenError)
    );
  });
}

start().catch((error) => {
  console.error(error);
  setConnection("Başlatma hatası", "danger");
  $("setupMessage").textContent = "Panel başlatılamadı. Tarayıcı konsolundaki teknik kayıt incelenmelidir.";
});
