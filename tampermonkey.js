// ==UserScript==
// @name         Gerador PDFs -> Kiwify Uploader
// @namespace    https://local.gerador-pdfs/
// @version      0.1.0
// @description  Le subir.json local e auxilia a publicar ebooks/bônus na Kiwify.
// @match        https://dashboard.kiwify.com/products
// @match        https://dashboard.kiwify.com/products*
// @match        https://dashboard.kiwify.com/*
// @match        https://dashboard.kiwify.com/products/*
// @match        https://*.kiwify.com/*
// @include      https://dashboard.kiwify.com/products*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    localBaseUrl: "http://localhost:8787",
    subirJsonUrl: "http://localhost:8787/subir.json",
    defaultPrice: "37,00",
    defaultSalesPageUrl: "https://www.instagram.com/realizart._/",
    orderBumpPrice: "8,99",
    queueStorageKey: "gp_kiwify_upload_queue_v1",
    createdBumpsStorageKey: "gp_kiwify_created_order_bumps_v1",
    resetAutomationStateRunId: "2026-05-28-resubir-todos-2",
    pollMs: 800,
    maxWaitMs: 20000
  };

  const state = {
    items: [],
    selected: null,
    running: false,
    uploadQueue: null,
    lastAutoStartAt: 0,
    log: []
  };

  console.log("[KiwifyUploader][INFORMANDO]", "Script carregado", {
    url: window.location.href
  });

  function log(message, data) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    state.log.unshift(data ? `${line} ${JSON.stringify(data)}` : line);
    state.log = state.log.slice(0, 80);
    console.log("[KiwifyUploader][INFORMANDO]", message, data || "");
  }

  function resetAutomationStateIfRequested() {
    const markerKey = "gp_kiwify_reset_done_run_id";
    if (!CONFIG.resetAutomationStateRunId) return;
    if (localStorage.getItem(markerKey) === CONFIG.resetAutomationStateRunId) return;

    const prefixes = [
      CONFIG.queueStorageKey,
      CONFIG.createdBumpsStorageKey,
      "kiwify_links_",
      "gp_kiwify_order_bumps_configured_"
    ];

    for (const key of Object.keys(localStorage)) {
      if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) {
        localStorage.removeItem(key);
      }
    }

    localStorage.setItem(markerKey, CONFIG.resetAutomationStateRunId);
    console.log("[KiwifyUploader][INFORMANDO]", "Estado da automacao resetado para reenviar todos os produtos.");
  }

  function consoleExecuting(message, data) {
    console.log("[KiwifyUploader][EXECUTANDO]", message, data || "");
  }

  function consoleSuccess(message, data) {
    console.log("[KiwifyUploader][SUCESSO]", message, data || "");
  }

  function consoleError(message, data) {
    console.log("[KiwifyUploader][ERRO]", message, data || "");
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: response => {
          try {
            resolve(JSON.parse(response.responseText));
          } catch (error) {
            reject(error);
          }
        },
        onerror: reject
      });
    });
  }

  function requestBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        onload: response => resolve(response.response),
        onerror: reject
      });
    });
  }

  function fixMojibake(text) {
    const value = String(text || "");
    const maybeBroken = [...value].some(char => [0x00c3, 0x00c2, 0x00e2].includes(char.charCodeAt(0)));
    if (!maybeBroken) return value;
    try {
      return decodeURIComponent(escape(value));
    } catch (error) {
      return value;
    }
  }

  function normalizeText(text) {
    return fixMojibake(text)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function byText(selector, text) {
    const needle = normalizeText(text);
    return [...document.querySelectorAll(selector)]
      .find(el => normalizeText(el.innerText || el.textContent || el.value).includes(needle));
  }

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function dispatchFieldEvents(el) {
    ["input", "change", "blur"].forEach(type => {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  async function waitFor(fn, label = "elemento") {
    const start = Date.now();
    while (Date.now() - start < CONFIG.maxWaitMs) {
      const result = fn();
      if (result) return result;
      await sleep(CONFIG.pollMs);
    }
    throw new Error(`Tempo esgotado aguardando ${label}`);
  }

  function findInputByLabel(labelText, root = document) {
    const labels = [...root.querySelectorAll("label")];
    const label = labels.find(item => normalizeText(item.textContent).includes(normalizeText(labelText)));
    if (label) {
      const forId = label.getAttribute("for");
      if (forId) {
        const byFor = document.getElementById(forId);
        if (byFor) return byFor;
      }

      const inside = label.querySelector("input, textarea, select");
      if (inside) return inside;

      const wrapper = label.closest("div, section, fieldset") || label.parentElement;
      const near = wrapper?.querySelector("input, textarea, select");
      if (near) return near;
    }

    const placeholders = [...root.querySelectorAll("input, textarea")]
      .find(input => normalizeText(input.placeholder).includes(normalizeText(labelText)));

    return placeholders || null;
  }

  function setNativeValue(el, value) {
    if (!el) throw new Error("Campo não encontrado");
    const proto = el.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : el.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    dispatchFieldEvents(el);
  }

  function clickText(texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const text of list) {
      const el = byText("button, a, [role='button'], .cursor-pointer", text);
      if (el && visible(el)) {
        el.click();
        return el;
      }
    }
    return null;
  }

  function setSelectValue(select, value) {
    if (!select) throw new Error("Select nao encontrado");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    const optionIndex = [...select.options].findIndex(option => option.value === value);
    if (optionIndex >= 0) select.selectedIndex = optionIndex;
    [...select.options].forEach(option => {
      option.selected = option.value === value;
    });
    setter ? setter.call(select, value) : (select.value = value);
    dispatchFieldEvents(select);
  }

  async function forceSelectValue(select, value, label) {
    if (!select) throw new Error(`Select ${label || ""} nao encontrado`);
    const option = [...select.options].find(item => item.value === value);
    if (!option) throw new Error(`Opcao ${value} nao encontrada no select ${label || ""}`);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      select.focus();
      setSelectValue(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      select.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      select.blur();
      await sleep(150);
    }

    console.log("[KiwifyUploader][DEBUG]", "Select forcado", {
      label,
      value,
      selectedValue: select.value,
      selectedIndex: select.selectedIndex,
      selectedText: select.options[select.selectedIndex]?.textContent?.trim()
    });
  }

  function findCreateProductDialog() {
    return [...document.querySelectorAll('[role="dialog"]')]
      .find(dialog => visible(dialog) && normalizeText(dialog.textContent).includes("criar produto"));
  }

  function clickTextInside(root, texts) {
    const list = Array.isArray(texts) ? texts : [texts];
    for (const text of list) {
      const needle = normalizeText(text);
      const el = [...root.querySelectorAll("button, a, [role='button'], .cursor-pointer")]
        .find(item => visible(item) && normalizeText(item.innerText || item.textContent).includes(needle));
      if (el) {
        el.click();
        return el;
      }
    }
    return null;
  }

  function getVisibleCreateProductDialog() {
    const dialog = findCreateProductDialog();
    if (!dialog) throw new Error("Modal Criar produto visivel nao encontrado");
    return dialog;
  }

  function getVisibleFieldByLabel(labelText, root) {
    const labels = [...root.querySelectorAll("label")].filter(visible);
    const label = labels.find(item => normalizeText(item.textContent).includes(normalizeText(labelText)));
    if (!label) return null;

    const wrapper = label.closest(".w-full, .w-auto, div") || label.parentElement;
    return [...wrapper.querySelectorAll("input, textarea, select")].find(visible) || null;
  }

  function getVisibleInputByLabel(labelText, root) {
    const labels = [...root.querySelectorAll("label")].filter(visible);
    const label = labels.find(item => normalizeText(item.textContent).includes(normalizeText(labelText)));
    if (!label) return null;

    const wrapper = label.closest(".w-full, .w-auto, div") || label.parentElement;
    return [...wrapper.querySelectorAll("input, textarea")].find(visible) || null;
  }

  function getFieldWrapperByLabel(labelText, root) {
    const labels = [...root.querySelectorAll("label")].filter(visible);
    const label = labels.find(item => normalizeText(item.textContent).includes(normalizeText(labelText)));
    return label?.closest(".w-full, .w-auto, div") || label?.parentElement || null;
  }

  function getControlNearLabel(labelText, root, selector, requireVisible = true) {
    const labels = [...root.querySelectorAll("label")].filter(label => !requireVisible || visible(label));
    const label = labels.find(item => normalizeText(item.textContent).includes(normalizeText(labelText)));
    if (!label) return null;

    let wrapper = label.parentElement;
    for (let depth = 0; wrapper && depth < 6; depth += 1, wrapper = wrapper.parentElement) {
      const controls = [...wrapper.querySelectorAll(selector)];
      const control = requireVisible ? controls.find(visible) : controls[0];
      if (control) return control;
    }
    return null;
  }

  function getSectionByHeading(text) {
    const needle = normalizeText(text);
    const heading = [...document.querySelectorAll("h3")]
      .find(item => visible(item) && normalizeText(item.textContent) === needle);
    return heading?.closest(".md\\:grid, .mt-10") || null;
  }

  function selectByTextOrValue(select, text, fallbackValue) {
    if (!select) return false;
    const needle = normalizeText(text);
    const option = [...select.options].find(item => normalizeText(item.textContent).includes(needle))
      || [...select.options].find(item => item.value === fallbackValue);
    if (!option) return false;
    setSelectValue(select, option.value);
    console.log("[KiwifyUploader][DEBUG]", "Select selecionado", {
      requestedText: text,
      fallbackValue,
      selectedValue: select.value,
      selectedText: select.options[select.selectedIndex]?.textContent?.trim()
    });
    return true;
  }

  function findCategorySelect(root = document) {
    return [...root.querySelectorAll("select")]
      .find(select => [...select.options].some(option => option.value === "999" && normalizeText(option.textContent).includes("selecione uma categoria")));
  }

  function findCurrencySelectNearPriceInput(root = document) {
    const priceInput = findPriceInput(root);
    const wrapper = priceInput?.closest("fieldset, .relative, div");
    return wrapper ? [...wrapper.querySelectorAll("select")].find(select => [...select.options].some(option => option.value === "BRL")) : null;
  }

  function findPriceInput(root = document) {
    return [...root.querySelectorAll("input.v-money, input[type='tel']")]
      .find(input => visible(input) && (input.classList.contains("v-money") || input.hasAttribute("minvalue")));
  }

  function findProductImageInput(root = document) {
    return root.querySelector("input.uppy-DragDrop-input[type='file'][accept*='image']")
      || [...root.querySelectorAll("input[type='file']")].find(input => String(input.accept || "").includes("image"))
      || document.querySelector("input.uppy-DragDrop-input[type='file'][accept*='image']")
      || [...document.querySelectorAll("input[type='file']")].find(input => String(input.accept || "").includes("image"));
  }

  function findSelectWithOptionValue(root, value) {
    return [...root.querySelectorAll("select")]
      .find(select => [...select.options].some(option => option.value === value));
  }

  function findTextInputNearText(root, text) {
    const needle = normalizeText(text);
    const node = [...root.querySelectorAll("div, span, label")]
      .find(item => visible(item) && normalizeText(item.textContent).includes(needle));
    const wrapper = node?.closest(".w-full, .flex, div") || node?.parentElement;
    return wrapper ? [...wrapper.querySelectorAll("input[type='text'], input:not([type])")].find(visible) : null;
  }

  function switchIsOn(toggle) {
    if (!toggle) return false;
    if (toggle.matches("input[type='checkbox']")) return toggle.checked;
    return toggle.getAttribute("aria-checked") === "true";
  }

  async function setSwitchByLabel(root, labelText, desired) {
    const label = [...root.querySelectorAll("label, span")]
      .find(item => visible(item) && normalizeText(item.textContent).includes(normalizeText(labelText)));
    if (!label) {
      consoleError("Switch nao encontrado", { labelText });
      return false;
    }

    const wrapper = label.closest(".flex, fieldset, div") || label.parentElement;
    const toggle = wrapper?.querySelector("input[type='checkbox'], [role='checkbox']");
    if (!toggle) {
      consoleError("Controle do switch nao encontrado", { labelText });
      return false;
    }

    if (switchIsOn(toggle) !== desired) {
      toggle.click();
      await sleep(200);
    }

    consoleSuccess("Switch configurado", { labelText, desired });
    return true;
  }

  function moneyDigits(value) {
    const raw = String(value || "").replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    const number = Number(raw);
    const safeNumber = Number.isFinite(number) && number >= 5 ? number : 37;
    return String(Math.round(safeNumber * 100));
  }

  function setMoneyValue(input, value) {
    const formatted = String(value || CONFIG.defaultPrice).replace("R$", "").trim() || CONFIG.defaultPrice;
    const digits = moneyDigits(value);
    input.focus();
    setNativeValue(input, "");
    setNativeValue(input, formatted);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: formatted
    }));
    if (Number(String(input.value).replace(/[^\d]/g, "")) < 500) {
      setNativeValue(input, digits);
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: digits
      }));
    }
    input.blur();
    dispatchFieldEvents(input);
    console.log("[KiwifyUploader][DEBUG]", "Preco apos set", {
      requested: value,
      formatted,
      digits,
      inputValue: input.value
    });
  }

  function moneyCentsFromInput(input) {
    const digits = String(input?.value || "").replace(/[^\d]/g, "");
    return Number(digits || 0);
  }

  async function ensureMoneyValue(input, value, label = "preco") {
    if (!input) throw new Error(`Input de ${label} nao encontrado`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      setMoneyValue(input, value);
      await sleep(350);
      const cents = moneyCentsFromInput(input);
      console.log("[KiwifyUploader][DEBUG]", "Verificacao de preco", {
        label,
        attempt,
        inputValue: input.value,
        cents
      });
      if (cents >= 500) return true;
    }
    return false;
  }

  async function completeCreateProductModal() {
    consoleExecuting("Aguardando modal Criar produto");
    const dialog = await waitFor(findCreateProductDialog, "modal Criar produto");

    if (findInputByLabel("nome do produto", dialog) || findInputByLabel("nome", dialog)) {
      consoleSuccess("Modal ja esta na tela de dados do produto");
      return dialog;
    }

    const selects = [...dialog.querySelectorAll("select")].filter(visible);

    if (selects[0]) {
      setSelectValue(selects[0], "charge");
      console.log("[KiwifyUploader][DEBUG]", "Select tipo pagamento apos set", {
        value: selects[0].value,
        selectedIndex: selects[0].selectedIndex
      });
      consoleSuccess("Tipo de pagamento selecionado", { value: "charge" });
    } else {
      consoleError("Select Tipo de pagamento nao encontrado");
    }

    if (selects[1]) {
      setSelectValue(selects[1], "club");
      console.log("[KiwifyUploader][DEBUG]", "Select entrega apos set", {
        value: selects[1].value,
        selectedIndex: selects[1].selectedIndex
      });
      consoleSuccess("Entrega do conteudo selecionada", { value: "club" });
    } else {
      consoleError("Select Entrega do conteudo nao encontrado");
    }

    consoleExecuting("Clicando em Continuar no modal Criar produto");
    const continued = clickTextInside(dialog, "Continuar");
    if (!continued) throw new Error("Botao Continuar do modal Criar produto nao encontrado");
    await sleep(1200);
    return dialog;
  }

  function findClickableAncestor(target) {
    let el = target instanceof Element ? target : null;
    for (let depth = 0; el && depth < 6; depth += 1, el = el.parentElement) {
      if (el.matches("button, a, [role='button'], .cursor-pointer")) return el;
    }
    return null;
  }

  function isCreateProductButton(el) {
    if (!el || !visible(el)) return false;
    if (el.closest("#gp-kiwify-panel")) return false;
    return normalizeText(el.innerText || el.textContent) === "criar produto";
  }

  function findCreateProductButtonOnList() {
    return [...document.querySelectorAll("button, a, [role='button'], .cursor-pointer, div")]
      .filter(el => !el.closest("#gp-kiwify-panel") && visible(el))
      .find(el => normalizeText(el.innerText || el.textContent) === "criar produto");
  }

  async function clickCreateProductOnList() {
    const button = await waitFor(findCreateProductButtonOnList, "botao Criar produto na lista");
    consoleExecuting("Clicando em Criar produto na lista", {
      tag: button.tagName,
      classes: button.className
    });
    button.scrollIntoView({ block: "center", inline: "center" });
    await sleep(250);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    button.click();
    return button;
  }

  function localUrlFromPath(pathValue) {
    if (!pathValue) return null;
    const normalized = String(pathValue).replace(/\\/g, "/");
    if (/^https?:\/\//i.test(normalized)) return normalized;
    return `${CONFIG.localBaseUrl}/${encodeURI(normalized).replace(/#/g, "%23")}`;
  }

  async function fileFromLocalPath(pathValue, fallbackName) {
    const url = localUrlFromPath(pathValue);
    if (!url) throw new Error("Caminho de arquivo vazio");
    const blob = await requestBlob(url);
    const name = fallbackName || decodeURIComponent(url.split("/").pop() || "arquivo.pdf");
    console.log("[KiwifyUploader][DEBUG]", "Arquivo local carregado", {
      url,
      name,
      type: blob.type,
      size: blob.size
    });
    if (!blob?.size) throw new Error(`Arquivo local vazio ou nao encontrado: ${url}`);
    return new File([blob], name, { type: blob.type || "application/pdf" });
  }

  async function setFileInput(input, file) {
    const data = new DataTransfer();
    data.items.add(file);
    input.files = data.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function setUppyFileInput(input, file) {
    const data = new DataTransfer();
    data.items.add(file);
    input.files = data.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const dropTarget = input.closest(".uppy-Root")?.querySelector(".uppy-DragDrop-container") || input.closest("button") || input;
    ["dragenter", "dragover", "drop"].forEach(type => {
      dropTarget.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: data
      }));
    });
  }

  async function uploadFileByNearestInput(pathValue, fallbackName) {
    const file = await fileFromLocalPath(pathValue, fallbackName);
    const input = await waitFor(
      () => [...document.querySelectorAll("input[type='file']")].find(visible),
      "input de upload"
    );
    await setFileInput(input, file);
    log(`Arquivo anexado: ${file.name}`);
  }

  function getMainPdf(item) {
    return item?.arquivos?.pdf_pt || item?.arquivos?.pdf || null;
  }

  function getOrderBumpBonuses(item) {
    return (item?.bonus || []).filter(bonus => bonus?.comercial?.tipo_oferta === "order_bump");
  }

  function orderBumpKey(mainItem, bonus, index) {
    return String(bonus?.id || bonus?.slug || bonus?.titulo || `bump_${index}`)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || `bump_${index}`;
  }

  function orderBumpsConfiguredKey(item) {
    return `gp_kiwify_order_bumps_configured_${item?.id || "produto"}`;
  }

  function getCreatedOrderBumps() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.createdBumpsStorageKey) || "{}");
    } catch (error) {
      consoleError("Registro de order bumps corrompido, reiniciando", { message: error.message });
      return {};
    }
  }

  function saveCreatedOrderBump(mainItem, bonusItem) {
    if (!bonusItem?.__sourceBonusKey) return;
    const registry = getCreatedOrderBumps();
    const mainKey = String(bonusItem.__sourceMainId || mainItem?.id || "produto");
    registry[mainKey] = registry[mainKey] || {};
    registry[mainKey][bonusItem.__sourceBonusKey] = {
      title: bonusItem.titulo || bonusItem.nome,
      itemId: bonusItem.id,
      price: CONFIG.orderBumpPrice,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(CONFIG.createdBumpsStorageKey, JSON.stringify(registry));
    consoleSuccess("Produto de order bump registrado", registry[mainKey][bonusItem.__sourceBonusKey]);
  }

  function makeOrderBumpProduct(mainItem, bonus, index) {
    const key = orderBumpKey(mainItem, bonus, index);
    const pdf = bonus?.arquivos?.pdf_pt || bonus?.arquivos?.pdf || null;
    const cover = bonus?.arquivos?.capa_pt || bonus?.arquivos?.capa || getCover(mainItem);
    return {
      ...mainItem,
      id: `${mainItem?.id || "produto"}__order_bump__${key}`,
      titulo: bonus?.titulo || bonus?.nome || `Bonus adicional ${index + 1}`,
      nome: bonus?.titulo || bonus?.nome || `Bonus adicional ${index + 1}`,
      descricao: bonus?.descricao || "Material complementar para adicionar ao pedido.",
      preco: { ...(bonus?.comercial?.preco || {}), valor_formatado: `R$ ${CONFIG.orderBumpPrice}` },
      arquivos: {
        ...(mainItem?.arquivos || {}),
        ...(bonus?.arquivos || {}),
        pdf,
        pdf_pt: pdf,
        capa: cover,
        capa_pt: cover
      },
      bonus: [],
      __isOrderBumpProduct: true,
      __sourceMainId: mainItem?.id,
      __sourceBonusKey: key,
      __sourceBonusIndex: index
    };
  }

  function getExpectedUploadItems(mainItem) {
    const bumps = getOrderBumpBonuses(mainItem).slice(0, 5);
    return [...bumps.map((bonus, index) => makeOrderBumpProduct(mainItem, bonus, index)), mainItem];
  }

  function isProductsListPage() {
    return /\/products\/?$/.test(window.location.pathname);
  }

  function findProductsTable() {
    return [...document.querySelectorAll("table")]
      .find(table => normalizeText(table.textContent).includes("nome") && normalizeText(table.textContent).includes("preco"));
  }

  function productListIsEmpty() {
    const table = findProductsTable();
    if (!table) return false;
    return ![...table.querySelectorAll("tbody tr")].some(row => visible(row) && normalizeText(row.textContent));
  }

  function productRowsFromList() {
    const table = findProductsTable();
    if (!table) return [];
    return [...table.querySelectorAll("tbody tr")]
      .filter(row => visible(row) && normalizeText(row.textContent))
      .map(row => {
        const cells = [...row.querySelectorAll("td")];
        const title = (cells[0]?.innerText || cells[0]?.textContent || row.innerText || row.textContent || "").trim();
        const price = (cells[1]?.innerText || cells[1]?.textContent || "").trim();
        return { row, title, price, normalizedTitle: normalizeText(title) };
      });
  }

  function productTitleExistsOnList(title, listText = collectProductListText()) {
    const wanted = normalizeText(title);
    if (!wanted) return false;
    const rows = productRowsFromList();
    if (rows.length) {
      return rows.some(item => item.normalizedTitle === wanted || item.normalizedTitle.includes(wanted) || wanted.includes(item.normalizedTitle));
    }
    return listText.includes(wanted);
  }

  function getMissingUploadItemsFromList(mainItem) {
    const expectedItems = getExpectedUploadItems(mainItem);
    if (!isProductsListPage() || !findProductsTable()) return expectedItems;

    const listText = collectProductListText();
    const missingItems = expectedItems.filter(item => !productTitleExistsOnList(item.titulo || item.nome, listText));
    const existingItems = expectedItems.filter(item => productTitleExistsOnList(item.titulo || item.nome, listText));

    if (productListIsEmpty()) {
      log("Tabela de produtos vazia. Todos os bonus e principais serao enviados.");
    } else {
      log("Leitura da tabela de produtos", {
        existentes: existingItems.map(item => item.titulo || item.nome),
        faltando: missingItems.map(item => item.titulo || item.nome)
      });
    }

    return missingItems;
  }

  function buildUploadQueue(mainItem) {
    return getMissingUploadItemsFromList(mainItem);
  }

  function loadUploadQueue() {
    try {
      const queue = JSON.parse(localStorage.getItem(CONFIG.queueStorageKey) || "null");
      if (!queue?.active || !Array.isArray(queue.items)) return null;
      return queue;
    } catch (error) {
      consoleError("Fila salva corrompida, limpando", { message: error.message });
      localStorage.removeItem(CONFIG.queueStorageKey);
      return null;
    }
  }

  function saveUploadQueue(queue) {
    state.uploadQueue = queue;
    if (queue?.active) localStorage.setItem(CONFIG.queueStorageKey, JSON.stringify(queue));
    else localStorage.removeItem(CONFIG.queueStorageKey);
  }

  function currentQueueItem() {
    const queue = state.uploadQueue || loadUploadQueue();
    if (!queue?.active || queue.phase === "verify") return null;
    state.uploadQueue = queue;
    return queue.items[queue.index] || null;
  }

  function getMainItemForQueue(queue, fallbackItem) {
    if (fallbackItem && !fallbackItem.__isOrderBumpProduct) return fallbackItem;
    if (Number.isInteger(queue?.sourceIndex) && state.items[queue.sourceIndex]) return state.items[queue.sourceIndex];
    return state.items.find(item => String(item?.id || item?.titulo) === String(queue?.mainId || queue?.mainTitle)) || fallbackItem || null;
  }

  function getMissingOrderBumpItems(mainItem) {
    return getMissingUploadItemsFromList(mainItem).filter(item => item.__isOrderBumpProduct);
  }

  function resetOrderBumpMarkersIfNeeded(mainItem, missingItems) {
    const hasMissingBump = missingItems.some(item => item.__isOrderBumpProduct);
    if (!hasMissingBump) return;
    localStorage.removeItem(orderBumpsConfiguredKey(mainItem));
    const registry = getCreatedOrderBumps();
    const mainKey = String(mainItem?.id || "produto");
    if (registry[mainKey]) {
      for (const missing of missingItems.filter(item => item.__isOrderBumpProduct)) {
        delete registry[mainKey][missing.__sourceBonusKey];
      }
      localStorage.setItem(CONFIG.createdBumpsStorageKey, JSON.stringify(registry));
    }
    log("Marcadores de order bump resetados porque ha bonus faltando na tabela.");
  }

  function makeQueueFromItems(mainItem, items, previousQueue = {}) {
    const sourceIndex = state.items.findIndex(item => String(item?.id || item?.titulo) === String(mainItem?.id || mainItem?.titulo));
    return {
      active: items.length > 0,
      phase: "upload",
      mainId: mainItem?.id,
      mainTitle: mainItem?.titulo || mainItem?.nome,
      sourceIndex: sourceIndex >= 0 ? sourceIndex : Number(previousQueue.sourceIndex) || 0,
      index: 0,
      items,
      autoContinue: Boolean(previousQueue.autoContinue),
      createdAt: previousQueue.createdAt || new Date().toISOString(),
      reconciledAt: new Date().toISOString()
    };
  }

  function reconcileQueueWithProductsTable(queue, fallbackItem) {
    if (!queue?.active || queue.phase === "verify" || !isProductsListPage() || !findProductsTable()) return queue;

    const mainItem = getMainItemForQueue(queue, fallbackItem);
    if (!mainItem) return queue;

    const missingItems = getMissingUploadItemsFromList(mainItem);
    resetOrderBumpMarkersIfNeeded(mainItem, missingItems);

    if (!missingItems.length) {
      log(`Fila salva descartada: ${mainItem.titulo || mainItem.nome} ja esta completo na tabela.`);
      saveUploadQueue({ active: false });
      return { ...queue, active: false, items: [] };
    }

    const current = queue.items?.[queue.index];
    const currentTitle = normalizeText(current?.titulo || current?.nome);
    const expectedFirstTitle = normalizeText(missingItems[0]?.titulo || missingItems[0]?.nome);
    const missingBumps = missingItems.filter(item => item.__isOrderBumpProduct);
    const currentIsMain = current && !current.__isOrderBumpProduct;

    if (missingBumps.length && (currentIsMain || currentTitle !== expectedFirstTitle)) {
      const reconciled = makeQueueFromItems(mainItem, missingItems, queue);
      reconciled.autoContinue = queue.autoContinue;
      saveUploadQueue(reconciled);
      log("Fila corrigida antes de criar: bonus faltantes voltaram para antes do principal.", {
        faltando: missingItems.map(item => item.titulo || item.nome)
      });
      return reconciled;
    }

    return queue;
  }

  function ensureUploadQueue(mainItem) {
    const existing = reconcileQueueWithProductsTable(loadUploadQueue(), mainItem);
    if (existing?.active && existing.phase !== "verify") {
      state.uploadQueue = existing;
      return existing;
    }

    const items = buildUploadQueue(mainItem);
    resetOrderBumpMarkersIfNeeded(mainItem, items);
    const queue = makeQueueFromItems(mainItem, items);

    if (queue.active && items.length > 1) {
      saveUploadQueue(queue);
      log(`Fila criada com ${items.length} produto(s) faltante(s) para este indice.`);
    } else if (queue.active) {
      saveUploadQueue(queue);
      log(`Fila criada com 1 produto faltante: ${items[0]?.titulo || items[0]?.nome}`);
    } else {
      saveUploadQueue({ active: false });
      log(`Indice ${queue.sourceIndex + 1} ja esta completo pela leitura da tabela: ${queue.mainTitle || queue.mainId}`);
    }

    return queue;
  }

  function getCover(item) {
    return item?.arquivos?.capa_pt || item?.arquivos?.capa || null;
  }

  function getProductDescription(item) {
    const base = item.descricao || item.subtitulo || item.titulo || `Produto ${item.id}`;
    if (String(base).length >= 100) return base;
    return `${base}. Material digital completo em formato ebook, com conteudo pratico, organizado e pronto para acesso na area de membros.`;
  }

  function getSalesPageUrl(item) {
    return item.pagina_vendas || item.url_vendas || item.link_vendas || item?.plataformas?.kiwify?.pagina_vendas || CONFIG.defaultSalesPageUrl;
  }

  function getKiwifyCategoryValue(item) {
    const text = normalizeText(`${item.categoria || ""} ${item.titulo || ""} ${item.subtitulo || ""}`);
    if (/saude|esporte|fitness|sobrevivencia/.test(text)) return "0";
    if (/financa|investimento|dinheiro|renda/.test(text)) return "1";
    if (/relacionamento|solteir|amor|casamento/.test(text)) return "2";
    if (/negocio|carreira|profissao|trabalho/.test(text)) return "3";
    if (/espiritual|religiao|fe/.test(text)) return "4";
    if (/sexualidade|sexo/.test(text)) return "5";
    if (/teoria|misterio|entretenimento|cinema|serie|jogo/.test(text)) return "6";
    if (/culinaria|gastronomia|receita/.test(text)) return "7";
    if (/idioma|ingles|espanhol/.test(text)) return "8";
    if (/direito|juridic|advoca/.test(text)) return "9";
    if (/app|software/.test(text)) return "10";
    if (/livro|literatura|romance|conto|poesia/.test(text)) return "11";
    if (/casa|construcao|decoracao/.test(text)) return "12";
    if (/desenvolvimento pessoal|produtividade|habito|mente/.test(text)) return "13";
    if (/moda|beleza|estetica/.test(text)) return "14";
    if (/animal|planta|pet/.test(text)) return "15";
    if (/educacional|educacao|curso|aprend/.test(text)) return "16";
    if (/hobb/.test(text)) return "17";
    if (/internet|social media|instagram|youtube/.test(text)) return "18";
    if (/ecologia|meio ambiente|sustent/.test(text)) return "19";
    if (/musica|arte/.test(text)) return "20";
    if (/tecnologia|programacao|informatica|ia|inteligencia artificial/.test(text)) return "21";
    if (/empreendedorismo|digital|marketing/.test(text)) return "22";
    return "23";
  }

  async function loadSubirJson() {
    const payload = await requestJson(CONFIG.subirJsonUrl);
    const items = Array.isArray(payload) ? payload : payload?.ebooks || [];
    state.items = items.filter(item => item?.subir === true);
    state.uploadQueue = loadUploadQueue();
    state.selected = currentQueueItem() || state.items[0] || null;
    log(`subir.json carregado: ${state.items.length} item(ns) com subir=true`);
    if (state.uploadQueue?.active) {
      const current = currentQueueItem();
      const phaseText = state.uploadQueue.phase === "verify" ? "verificando lista" : `item ${state.uploadQueue.index + 1}/${state.uploadQueue.items.length}`;
      log(`Fila em andamento: ${phaseText} - ${current?.titulo || state.uploadQueue.mainTitle || state.uploadQueue.mainId}`);
    }
  }

  async function fillProductBasics(item) {
    const title = item.titulo || item.nome || `Produto ${item.id}`;
    const description = getProductDescription(item);
    const price = item?.preco?.valor_formatado?.replace("R$", "").trim() || CONFIG.defaultPrice;
    const salesPageUrl = getSalesPageUrl(item);
    const dialog = getVisibleCreateProductDialog();

    consoleExecuting("Preenchendo dados basicos do produto", { title, price });

    const nameInput = getVisibleFieldByLabel("nome do produto", dialog);
    if (nameInput) {
      setNativeValue(nameInput, title);
      consoleSuccess("Campo nome preenchido", { title });
    } else {
      consoleError("Campo nome nao encontrado");
    }

    const descInput = getVisibleFieldByLabel("descrição", dialog) || getVisibleFieldByLabel("descricao", dialog);
    if (descInput) {
      setNativeValue(descInput, description);
      consoleSuccess("Campo descricao preenchido");
    } else {
      consoleError("Campo descricao nao encontrado");
    }

    const salesPageInput = getVisibleFieldByLabel("pagina de vendas", dialog) || getVisibleFieldByLabel("página de vendas", dialog);
    if (salesPageInput) {
      setNativeValue(salesPageInput, salesPageUrl);
      consoleSuccess("Campo pagina de vendas preenchido", { salesPageUrl });
    } else {
      consoleError("Campo pagina de vendas nao encontrado");
    }

    const priceWrapper = getFieldWrapperByLabel("preço", dialog) || getFieldWrapperByLabel("preco", dialog);
    const currencySelect = priceWrapper ? [...priceWrapper.querySelectorAll("select")].find(visible) : null;
    if (currencySelect) {
      setSelectValue(currencySelect, "BRL");
      consoleSuccess("Moeda selecionada", { value: "BRL" });
    } else {
      consoleError("Select de moeda nao encontrado");
    }

    const priceInput = getVisibleInputByLabel("preço", dialog) || getVisibleInputByLabel("preco", dialog);
    if (priceInput) {
      await ensureMoneyValue(priceInput, price, "preco modal");
      consoleSuccess("Campo preco preenchido", { price });
    } else {
      consoleError("Campo preco nao encontrado");
    }

    log("Dados básicos preenchidos", { title, price });
  }

  async function clickFinalCreateProductButton() {
    const dialog = findCreateProductDialog();
    if (!dialog) throw new Error("Modal Criar produto nao encontrado para finalizar");

    consoleExecuting("Clicando no botao final Criar produto");
    const button = [...dialog.querySelectorAll("button")]
      .filter(visible)
      .find(item => normalizeText(item.innerText || item.textContent) === "criar produto");
    if (button) button.click();
    if (!button) throw new Error("Botao final Criar produto nao encontrado");

    await sleep(1500);
    consoleSuccess("Clique final em Criar produto enviado");
  }

  async function uploadProductImage(item, root) {
    const cover = getCover(item) || item?.arquivos?.imagem_principal;
    if (!cover?.caminho) {
      consoleError("Imagem/capa do produto nao encontrada no subir.json");
      return;
    }

    const imageInput = findProductImageInput(root);
    if (!imageInput) {
      consoleError("Input de imagem do produto nao encontrado");
      return;
    }

    consoleExecuting("Buscando imagem do produto no servidor local", cover);
    const file = await fileFromLocalPath(cover.caminho, cover.nome);
    await setUppyFileInput(imageInput, file);
    consoleSuccess("Imagem do produto anexada", { file: file.name });
  }

  function uploadLooksComplete(root = document) {
    const progressBars = [...root.querySelectorAll("[role='progressbar'], .uppy-StatusBar-progress")];
    if (!progressBars.length) return true;

    return progressBars.some(progress => {
      const now = Number(progress.getAttribute("aria-valuenow") || 0);
      const width = String(progress.style?.width || "");
      return now >= 100 || width.includes("100%");
    }) || normalizeText(root.textContent).includes("100%");
  }

  async function waitForProductImageUpload(root = document) {
    const hasUppy = root.querySelector(".uppy-Root, .uppy-DragDrop-container")
      || document.querySelector(".uppy-Root, .uppy-DragDrop-container");
    if (!hasUppy) return;

    consoleExecuting("Aguardando upload da imagem chegar em 100%");
    await waitFor(() => uploadLooksComplete(root) || uploadLooksComplete(document), "upload da imagem 100%");
    await sleep(500);
    consoleSuccess("Upload da imagem concluido");
  }

  function findSaveProductButton() {
    return [...document.querySelectorAll("button")]
      .filter(visible)
      .find(button => normalizeText(button.innerText || button.textContent) === "salvar produto");
  }

  function findProductTabLink(tabValue, labelText) {
    const label = normalizeText(labelText);
    return [...document.querySelectorAll(`a[href*="tab=${tabValue}"]`)]
      .find(visible)
      || [...document.querySelectorAll("nav a")]
        .find(link => visible(link) && normalizeText(link.textContent).includes(label));
  }

  async function openProductTab(tabValue, labelText) {
    consoleExecuting("Abrindo aba do produto", { tabValue, labelText });

    const mobileSelect = [...document.querySelectorAll("select")]
      .find(select => visible(select) && [...select.options].some(option => option.value === tabValue));
    if (mobileSelect) {
      setSelectValue(mobileSelect, tabValue);
    } else {
      const link = findProductTabLink(tabValue, labelText);
      if (!link) throw new Error(`Aba ${labelText} nao encontrada`);
      link.click();
    }

    await waitFor(
      () => window.location.search.includes(`tab=${tabValue}`)
        || document.querySelector(`#${tabValue}`)
        || findProductTabLink(tabValue, labelText)?.getAttribute("aria-current") === "page",
      `aba ${labelText}`
    );
    await sleep(800);
    consoleSuccess("Aba do produto aberta", { tabValue, labelText });
  }

  function productSavedToastVisible() {
    return [...document.querySelectorAll("div, section, aside, [role='alert']")]
      .filter(visible)
      .some(el => {
        const text = normalizeText(el.innerText || el.textContent);
        return text.includes("alteracoes do produto foram salvas")
          || text.includes("alteracao do produto foi salva")
          || text.includes("produto foram salvas")
          || text.includes("produto salvo")
          || text.includes("salvo com sucesso");
      });
  }

  async function waitForProductSaveConfirmation() {
    try {
      await waitFor(productSavedToastVisible, "confirmacao de produto salvo");
      consoleSuccess("Confirmacao de produto salvo detectada");
    } catch (error) {
      consoleError("Nao detectei toast de produto salvo; seguindo apos espera curta", { message: error.message });
      await sleep(1500);
    }
  }

  async function clickSaveProductWhenReady() {
    const button = await waitFor(findSaveProductButton, "botao Salvar produto");
    consoleExecuting("Clicando em Salvar produto");
    button.scrollIntoView({ block: "center", inline: "center" });
    await sleep(200);
    button.click();
    await waitForProductSaveConfirmation();
    consoleSuccess("Produto salvo e confirmado");
  }

  async function fillPaymentSettings() {
    const paymentSection = getSectionByHeading("Pagamento");
    if (!paymentSection) {
      consoleError("Secao Pagamento nao encontrada");
      return;
    }

    const paymentMethod = findSelectWithOptionValue(paymentSection, "3");
    if (paymentMethod) {
      await forceSelectValue(paymentMethod, "3", "metodo de pagamento");
      consoleSuccess("Pagamento: metodo selecionado", { value: "3" });
    }

    const invoiceInput = findTextInputNearText(paymentSection, "KIWIFY");
    if (invoiceInput) {
      setNativeValue(invoiceInput, "REALIZART");
      consoleSuccess("Pagamento: descricao na fatura preenchida", { value: "REALIZART" });
    }

    const installments = getControlNearLabel("parcelamento", paymentSection, "select")
      || [...paymentSection.querySelectorAll("select")].find(select => [...select.options].some(option => option.value === "12"));
    if (installments) {
      await forceSelectValue(installments, "1", "parcelamento");
      consoleSuccess("Pagamento: parcelamento apenas a vista");
    }

    const boletoInput = getVisibleInputByLabel("validade do boleto", paymentSection)
      || [...paymentSection.querySelectorAll("input[type='tel']")].find(visible);
    if (boletoInput) {
      setNativeValue(boletoInput, "3");
      consoleSuccess("Pagamento: validade do boleto preenchida", { dias: 3 });
    }

    await setSwitchByLabel(paymentSection, "Habilitar pagamento com 2 cartões", false);
    await setSwitchByLabel(paymentSection, "Habilitar pagamento com Cartão + Pix", false);
    await setSwitchByLabel(paymentSection, "Habilitar parcelamento inteligente", false);
    await setSwitchByLabel(paymentSection, "Pedir para o comprador repetir o e-mail", true);
    await setSwitchByLabel(paymentSection, "Coletar o endereço do comprador", false);
    await setSwitchByLabel(paymentSection, "Coletar o Instagram do comprador", false);
    await setSwitchByLabel(paymentSection, "Conversão automática de moedas", true);
  }

  function collectKiwifyLinks(item) {
    const rows = [...document.querySelectorAll("table tbody tr")].filter(visible);
    const links = rows.map(row => {
      const cells = [...row.querySelectorAll("td")];
      const name = normalizeText(cells[1]?.textContent || "");
      const urlInput = cells[2]?.querySelector("input");
      const url = urlInput?.value || urlInput?.getAttribute("value") || "";
      const type = normalizeText(cells[3]?.textContent || "");
      const price = (cells[4]?.textContent || "").trim();
      const status = normalizeText(cells[5]?.textContent || "");
      return { name, url, type, price, status };
    }).filter(link => link.name || link.url);

    if (!links.length) return [];

    const storageKey = `kiwify_links_${item?.id || "produto"}`;
    localStorage.setItem(storageKey, JSON.stringify({
      itemId: item?.id,
      title: item?.titulo || item?.nome,
      links,
      savedAt: new Date().toISOString()
    }));

    consoleSuccess("Links Kiwify registrados", { storageKey, links });
    return links;
  }

  async function fillProductEditPage(item) {
    consoleExecuting("Aguardando pagina de edicao do produto");
    const root = await waitFor(() => document.querySelector("#general"), "aba geral do produto");
    const title = item.titulo || item.nome || `Produto ${item.id}`;
    const description = getProductDescription(item);
    const price = item?.preco?.valor_formatado?.replace("R$", "").trim() || CONFIG.defaultPrice;
    const salesPageUrl = getSalesPageUrl(item);

    const productSection = getSectionByHeading("Produto") || root;
    const nameInput = getVisibleFieldByLabel("nome do produto", productSection);
    if (nameInput) {
      setNativeValue(nameInput, title);
      consoleSuccess("Editor: nome do produto preenchido", { title });
    }

    const descInput = getVisibleFieldByLabel("descrição", productSection) || getVisibleFieldByLabel("descricao", productSection);
    if (descInput) {
      setNativeValue(descInput, description);
      consoleSuccess("Editor: descricao preenchida");
    }

    const categorySelect = await waitFor(
      () => findCategorySelect(productSection) || findCategorySelect(root) || findCategorySelect(document),
      "select de categoria"
    );
    if (categorySelect?.tagName === "SELECT") {
      const categoryValue = getKiwifyCategoryValue(item);
      await forceSelectValue(categorySelect, categoryValue, "categoria");
      consoleSuccess("Editor: categoria selecionada", {
        categoria: item.categoria || "Outros",
        value: categoryValue,
        selected: categorySelect.options[categorySelect.selectedIndex]?.textContent?.trim()
      });
    } else {
      consoleError("Editor: select de categoria nao encontrado");
    }

    const languageSelect = getControlNearLabel("idioma dos emails", productSection, "select");
    if (languageSelect?.tagName === "SELECT") {
      setSelectValue(languageSelect, "PT");
      consoleSuccess("Editor: idioma dos emails selecionado", { value: "PT" });
    }

    const salesPageInput = getVisibleInputByLabel("página de vendas", productSection) || getVisibleInputByLabel("pagina de vendas", productSection);
    if (salesPageInput) {
      setNativeValue(salesPageInput, salesPageUrl);
      consoleSuccess("Editor: pagina de vendas preenchida", { salesPageUrl });
    }

    await uploadProductImage(item, productSection);

    const pricesSection = getSectionByHeading("Preços") || root;
    const currencySelect = findCurrencySelectNearPriceInput(pricesSection) || findCurrencySelectNearPriceInput(root) || findCurrencySelectNearPriceInput(document);
    if (currencySelect) {
      setSelectValue(currencySelect, "BRL");
      consoleSuccess("Editor: moeda selecionada", { value: "BRL" });
    } else {
      consoleError("Editor: select de moeda nao encontrado");
    }

    const priceInput = findPriceInput(pricesSection) || findPriceInput(root) || findPriceInput(document);
    if (priceInput) {
      const ok = await ensureMoneyValue(priceInput, price, "preco editor");
      ok ? consoleSuccess("Editor: preco preenchido", { price }) : consoleError("Editor: preco continua vazio ou abaixo do minimo", { value: priceInput.value });
    } else {
      consoleError("Editor: input de preco nao encontrado");
    }

    await waitForProductImageUpload(productSection);

    await openProductTab("settings", "Configuracoes");
    await waitFor(() => getSectionByHeading("Pagamento"), "secao Pagamento em Configuracoes");
    await fillPaymentSettings();

    if (!item.__isOrderBumpProduct) {
      await configureOrderBumps(item);
    }

    await openProductTab("links", "Links");
    await sleep(1000);
    collectKiwifyLinks(item);
    await clickSaveProductWhenReady();

    log("Pagina de edicao preenchida. Revise e salve/publice se a Kiwify exigir.");
  }

  async function createOrFillProduct(item, options = {}) {
    log("Iniciando produto", { id: item.id, titulo: item.titulo });
    consoleExecuting("Start do fluxo de criar produto", {
      id: item.id,
      titulo: item.titulo,
      acionadoPeloBotaoDaKiwify: Boolean(options.skipCreateButtonClick)
    });

    if (!options.skipCreateButtonClick) {
      consoleExecuting("Clicando no botao Criar produto/Novo produto");
      await clickCreateProductOnList();
      await sleep(1500);
    } else {
      consoleSuccess("Clique original no botao Criar produto detectado");
      await sleep(700);
    }

    await completeCreateProductModal();

    consoleExecuting("Aguardando formulario de dados do produto");
    await waitFor(
      () => {
        const dialog = findCreateProductDialog();
        return dialog && getVisibleFieldByLabel("nome do produto", dialog);
      },
      "formulario de dados do produto"
    );

    await fillProductBasics(item);
    await clickFinalCreateProductButton();
    await fillProductEditPage(item);
    consoleSuccess("Produto criado/preenchido com sucesso", {
      id: item.id,
      titulo: item.titulo
    });

    log("Revise a tela e clique em salvar/criar se a Kiwify exigir confirmação manual.");
  }

  async function uploadMemberAreaContent(item) {
    const mainPdf = getMainPdf(item);
    if (!mainPdf?.caminho) throw new Error("PDF principal sem caminho no subir.json");

    log("Preparando upload do ebook principal");
    clickText(["Área de membros", "Area de membros", "Conteúdo", "Conteudo", "Aulas"]);
    await sleep(1000);

    clickText(["Novo módulo", "Novo modulo", "Adicionar módulo", "Adicionar modulo"]);
    await sleep(700);
    const moduleInput = findInputByLabel("nome") || document.querySelector("input");
    if (moduleInput) setNativeValue(moduleInput, "Ebook principal");
    clickText(["Salvar", "Criar"]);
    await sleep(1000);

    clickText(["Nova aula", "Adicionar aula", "Novo conteúdo", "Novo conteudo"]);
    await sleep(1000);
    const lessonInput = findInputByLabel("nome") || findInputByLabel("título") || document.querySelector("input");
    if (lessonInput) setNativeValue(lessonInput, item.titulo || "Ebook principal");

    await uploadFileByNearestInput(mainPdf.caminho, mainPdf.nome);
    clickText(["Salvar", "Publicar", "Concluir"]);

    for (const bonus of item.bonus || []) {
      if (bonus?.comercial?.tipo_oferta !== "bonus_gratuito") continue;
      const pdf = bonus?.arquivos?.pdf;
      if (!pdf?.caminho) continue;

      await sleep(1200);
      clickText(["Nova aula", "Adicionar aula", "Novo conteúdo", "Novo conteudo"]);
      await sleep(1000);
      const input = findInputByLabel("nome") || findInputByLabel("título") || document.querySelector("input");
      if (input) setNativeValue(input, bonus.titulo || "Bônus gratuito");
      await uploadFileByNearestInput(pdf.caminho, pdf.nome);
      clickText(["Salvar", "Publicar", "Concluir"]);
      log(`Bônus gratuito anexado: ${bonus.titulo}`);
    }
  }

  function findVisibleModalByTitle(titleText) {
    const needle = normalizeText(titleText);
    return [...document.querySelectorAll('[role="dialog"], section')]
      .find(root => visible(root) && normalizeText(root.textContent).includes(needle));
  }

  function getFormRowByLabel(root, labelText) {
    const label = [...root.querySelectorAll("label")]
      .find(item => visible(item) && normalizeText(item.textContent).includes(normalizeText(labelText)));
    if (!label) return null;

    let row = label.parentElement;
    for (let depth = 0; row && depth < 6; depth += 1, row = row.parentElement) {
      const hasControl = [...row.querySelectorAll("select, input, [role='combobox'], .v-select, .vs__dropdown-toggle")]
        .some(control => control !== label && visible(control));
      if (hasControl) return row;
    }

    return label.parentElement;
  }

  function optionMatchesText(optionText, wantedText) {
    const option = normalizeText(optionText);
    const wanted = normalizeText(wantedText);
    if (!wanted) return false;
    if (option.includes(wanted) || wanted.includes(option)) return true;

    const words = wanted.split(" ").filter(word => word.length >= 4);
    if (!words.length) return false;
    return words.every(word => option.includes(word));
  }

  function optionLooksValid(option) {
    const text = normalizeText(option.innerText || option.textContent);
    if (!text) return false;
    if (text.includes("nenhum resultado") || text.includes("no options")) return false;
    if (text.includes("adicionar order bump") && text.includes("cancelar")) return false;
    if (text.includes("produto oferta") && text.includes("call to action")) return false;
    return true;
  }

  function visibleDropdownOptions(row = document) {
    const combobox = row.querySelector?.("[role='combobox']");
    const listboxId = combobox?.getAttribute("aria-owns") || combobox?.getAttribute("aria-controls");
    const listbox = listboxId ? document.getElementById(listboxId) : null;
    const scopedRoots = [
      listbox,
      row.querySelector?.("ul[role='listbox']"),
      row.querySelector?.(".vs__dropdown-menu"),
      row.querySelector?.(".v-select")
    ].filter(Boolean);

    const scopedOptions = scopedRoots.flatMap(root => [
      ...root.querySelectorAll("[role='option'], .vs__dropdown-option, li")
    ]);

    const globalOptions = [
      ...document.querySelectorAll("[role='option'], .vs__dropdown-option, ul[role='listbox'] li, [id*='listbox'] li")
    ];

    return [...new Set([...scopedOptions, ...globalOptions])]
      .filter(option => visible(option) && !option.closest("#gp-kiwify-panel"))
      .filter(optionLooksValid);
  }

  function clickLikeUser(el) {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.click();
  }

  async function openDropdownForRow(row) {
    const target = row.querySelector(".vs__dropdown-toggle")
      || row.querySelector("[role='combobox']")
      || row.querySelector(".v-select")
      || row.querySelector("select")
      || row.querySelector("input[type='search']")
      || [...row.querySelectorAll("div, button")].filter(visible).pop();

    if (!target) throw new Error("Controle de dropdown nao encontrado");
    target.scrollIntoView({ block: "center", inline: "center" });
    await sleep(150);
    clickLikeUser(target);
    await sleep(500);
    return target;
  }

  async function selectNativeOption(select, searchText, allowFirst, labelText) {
    const options = [...select.options];
    const option = options.find(item => optionMatchesText(item.textContent, searchText))
      || (allowFirst ? options.find(item => item.value && normalizeText(item.textContent)) : null);
    if (!option) throw new Error(`Opcao "${searchText}" nao encontrada em ${labelText}`);
    setSelectValue(select, option.value);
    await sleep(500);
    consoleSuccess("Opcao selecionada", { labelText, searchText, selected: option.textContent.trim() });
    return option;
  }

  function setSearchInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) || "a" }));
  }

  function searchTermsForOption(text) {
    const raw = String(text || "").trim();
    const normalized = normalizeText(raw);
    const words = normalized.split(" ").filter(word => word.length >= 3);
    const terms = [raw, normalized];

    if (words.length >= 2) terms.push(words.slice(0, 2).join(" "));
    if (words.length >= 3) terms.push(words.slice(0, 3).join(" "));
    if (words.length >= 2) terms.push(words.slice(-2).join(" "));
    if (words.length >= 1) terms.push(words[0]);

    return [...new Set(terms.filter(Boolean))];
  }

  async function optionsAfterSearching(row, searchText) {
    const terms = searchTermsForOption(searchText);
    const searchInput = row.querySelector(".vs__search, input[type='search'], input[placeholder*='Selecione']");

    for (const term of terms) {
      await openDropdownForRow(row);
      if (searchInput) {
        searchInput.focus();
        setSearchInputValue(searchInput, "");
        await sleep(120);
        setSearchInputValue(searchInput, term);
      }
      await sleep(1300);

      const options = visibleDropdownOptions(row);
      const exact = options.find(item => optionMatchesText(item.innerText || item.textContent, searchText));
      if (exact) return { options, option: exact, term };

      const byTerm = options.find(item => optionMatchesText(item.innerText || item.textContent, term));
      if (byTerm) return { options, option: byTerm, term };
    }

    return { options: visibleDropdownOptions(row), option: null, term: terms[terms.length - 1] || "" };
  }

  async function selectVueOptionByLabel(root, labelText, searchText, allowFirst = false) {
    const row = getFormRowByLabel(root, labelText);
    if (!row) throw new Error(`Linha do campo ${labelText} nao encontrada`);

    const nativeSelect = row.querySelector("select");
    if (nativeSelect) return selectNativeOption(nativeSelect, searchText, allowFirst, labelText);

    let result = { options: [], option: null, term: "" };
    if (searchText) {
      result = await optionsAfterSearching(row, searchText);
    } else {
      await openDropdownForRow(row);
      await sleep(1200);
      result.options = visibleDropdownOptions(row);
    }

    let option = result.option || (allowFirst ? result.options[0] : null);
    if (!option && allowFirst) {
      await openDropdownForRow(row);
      await sleep(1000);
      result.options = visibleDropdownOptions(row);
      option = result.options[0] || null;
    }

    if (!option) {
      consoleError("Opcoes visiveis no dropdown", {
        labelText,
        searchText,
        termoUsado: result.term,
        options: result.options.slice(0, 30).map(item => (item.innerText || item.textContent || "").trim())
      });
      throw new Error(`Opcao "${searchText}" nao encontrada em ${labelText}`);
    }

    const selectedText = (option.innerText || option.textContent || "").trim();
    if (normalizeText(selectedText).includes("adicionar order bump") || normalizeText(selectedText).includes("cancelar")) {
      throw new Error(`Opcao invalida capturada em ${labelText}: ${selectedText.slice(0, 120)}`);
    }

    clickLikeUser(option);
    await sleep(1000);
    consoleSuccess("Opcao selecionada", { labelText, searchText, termoUsado: result.term, selected: selectedText });
    return option;
  }

  function orderBumpSectionText() {
    const section = getSectionByHeading("Order bump");
    return normalizeText(section?.innerText || section?.textContent || "");
  }

  function orderBumpAlreadyConfiguredForBonus(bonus) {
    const sectionText = orderBumpSectionText();
    return sectionText && sectionText.includes(normalizeText(bonus?.titulo || bonus?.nome));
  }

  function findOrderBumpAddButton(modal) {
    return [...modal.querySelectorAll("button, [role='button'], .cursor-pointer")]
      .filter(visible)
      .find(button => normalizeText(button.innerText || button.textContent) === "adicionar");
  }

  async function clickAddOrderBumpAndWait(modal, bonus) {
    const button = await waitFor(() => findOrderBumpAddButton(modal), "botao Adicionar do order bump");
    consoleExecuting("Clicando em Adicionar no modal de order bump", { bonus: bonus?.titulo || bonus?.nome });
    button.scrollIntoView({ block: "center", inline: "center" });
    await sleep(200);
    clickLikeUser(button);

    try {
      await waitFor(() => !visible(modal) || orderBumpAlreadyConfiguredForBonus(bonus), "modal fechar ou order bump aparecer na lista");
      await sleep(700);
      return true;
    } catch (error) {
      consoleError("Modal nao confirmou o order bump; tentando clique final novamente", { message: error.message });
      const retryButton = findOrderBumpAddButton(modal);
      if (retryButton) {
        clickLikeUser(retryButton);
        await waitFor(() => !visible(modal) || orderBumpAlreadyConfiguredForBonus(bonus), "modal fechar apos segundo clique");
        await sleep(700);
        return true;
      }
      throw error;
    }
  }
  async function configureOrderBumps(item) {
    const bumps = getOrderBumpBonuses(item).slice(0, 5);
    if (!bumps.length) return;

    log(`Configurando ${bumps.length} order bump(s) no produto principal`);
    await waitFor(() => getSectionByHeading("Order bump"), "secao Order bump");

    const registry = getCreatedOrderBumps()[String(item?.id || "produto")] || {};

    for (const [index, bonus] of bumps.entries()) {
      if (orderBumpAlreadyConfiguredForBonus(bonus)) {
        log(`Order bump ja presente no principal, pulando: ${bonus.titulo || bonus.nome}`);
        continue;
      }

      const key = orderBumpKey(item, bonus, index);
      const created = registry[key] || {};
      const productTitle = created.title || bonus.titulo || bonus.nome;
      clickText(["Adicionar order bump", "Novo order bump", "Adicionar bump", "Criar order bump"]);
      const modal = await waitFor(() => findVisibleModalByTitle("Adicionar order bump"), "modal Adicionar order bump");

      await selectVueOptionByLabel(modal, "Produto", productTitle, false);
      await selectVueOptionByLabel(modal, "Oferta", "", true);

      const ctaInput = getVisibleInputByLabel("Call to action", modal);
      if (ctaInput) setNativeValue(ctaInput, "Sim, eu aceito essa oferta especial!");

      const titleInput = getVisibleInputByLabel("Titulo", modal) || getVisibleInputByLabel("T?tulo", modal) || getVisibleInputByLabel("T??tulo", modal);
      if (titleInput) setNativeValue(titleInput, bonus.titulo || bonus.nome || "Bonus adicional");

      const descInput = getVisibleInputByLabel("Descricao", modal) || getVisibleInputByLabel("Descri??o", modal) || getVisibleInputByLabel("Descri????o", modal);
      if (descInput) setNativeValue(descInput, bonus.descricao || "Adicione este material complementar ao seu pedido.");

      await clickAddOrderBumpAndWait(modal, bonus);
      log(`Order bump vinculado ao principal: ${productTitle}`);
    }

    localStorage.setItem(orderBumpsConfiguredKey(item), "true");
  }

  async function advanceUploadQueueAfterSuccess(createdItem) {
    const queue = state.uploadQueue || loadUploadQueue();
    if (!queue?.active) return false;

    if (createdItem?.__isOrderBumpProduct) {
      saveCreatedOrderBump({ id: queue.mainId }, createdItem);
    }

    queue.index += 1;
    if (queue.index >= queue.items.length) {
      queue.phase = "verify";
      queue.autoContinue = true;
      saveUploadQueue(queue);
      log("Produto salvo. Voltando para a tela inicial para confirmar na tabela antes do proximo indice.");
      await sleep(700);
      window.location.assign("https://dashboard.kiwify.com/products");
      return true;
    }

    queue.phase = "upload";
    queue.autoContinue = true;
    saveUploadQueue(queue);
    log(`Produto salvo. Voltando para a tela inicial para criar: ${queue.items[queue.index]?.titulo || queue.items[queue.index]?.nome}`);
    await sleep(700);
    window.location.assign("https://dashboard.kiwify.com/products");
    return true;
  }

  async function runSelected(options = {}) {
    if (!state.selected) {
      consoleError("Nenhum item com subir=true selecionado");
      log("Nenhum item com subir=true selecionado.");
      return;
    }
    if (state.running) {
      consoleExecuting("Fluxo ja esta em execucao, ignorando novo start");
      return;
    }

    if (!state.uploadQueue?.active && !options.fromQueue) {
      const queue = ensureUploadQueue(state.selected);
      if (!queue.active) {
        const nextMainItem = getNextMainItemAfterQueue(queue);
        if (nextMainItem && isProductsListPage()) {
          await startNextQueueFromProducts(nextMainItem);
        } else {
          log("Nada faltante para subir pela leitura da tabela.");
        }
        return;
      }
      state.selected = queue.items[queue.index];
      options.fromQueue = true;
    } else {
      state.uploadQueue = reconcileQueueWithProductsTable(state.uploadQueue || loadUploadQueue(), state.selected);
      state.selected = currentQueueItem() || state.selected;
      options.fromQueue = Boolean(state.uploadQueue?.active);
    }

    if (state.uploadQueue?.active) {
      state.uploadQueue = reconcileQueueWithProductsTable(state.uploadQueue, state.selected);
      state.selected = currentQueueItem() || state.selected;
    }

    if (!state.selected || state.uploadQueue?.active === false) {
      log("Nada faltante para subir apos reconferencia da tabela.");
      return;
    }

    consoleExecuting("Executando criacao/preenchimento do produto selecionado", {
      id: state.selected.id,
      titulo: state.selected.titulo,
      tipo: state.selected.__isOrderBumpProduct ? "order_bump_produto" : "principal"
    });
    state.running = true;
    try {
      const createdItem = state.selected;
      await createOrFillProduct(createdItem, options);
      consoleSuccess("Criado com sucesso", {
        id: createdItem.id,
        titulo: createdItem.titulo
      });
      const continuing = await advanceUploadQueueAfterSuccess(createdItem);
      if (!continuing) log("Etapa produto finalizada. Se a pagina mudou, clique em Continuar upload/conteudo.");
    } catch (error) {
      consoleError("Erro ao criar/preencher produto", { message: error.message });
      log(`Erro: ${error.message}`);
    } finally {
      state.running = false;
    }
  }

  async function runContent() {
    if (!state.selected || state.running) return;
    state.running = true;
    try {
      await uploadMemberAreaContent(state.selected);
      await configureOrderBumps(state.selected);
      log("Fluxo de conteúdo/order bumps concluído ou aguardando revisão da Kiwify.");
    } catch (error) {
      log(`Erro no conteúdo: ${error.message}`);
    } finally {
      state.running = false;
    }
  }

  async function startFromCreateProductTrigger(reason) {
    const now = Date.now();
    if (state.running) {
      consoleExecuting("Fluxo ja esta em execucao, gatilho ignorado", { reason });
      return;
    }
    if (now - state.lastAutoStartAt < 1500) {
      consoleExecuting("Gatilho duplicado ignorado", { reason });
      return;
    }
    state.lastAutoStartAt = now;

    consoleExecuting("Start automatico acionado pelo Criar produto", { reason });

    if (!state.selected) {
      try {
        consoleExecuting("Nenhum item selecionado ainda, relendo subir.json");
        await loadSubirJson();
      } catch (error) {
        consoleError("Falha ao reler subir.json antes do start", { message: error.message });
      }
    }

    runSelected({ skipCreateButtonClick: true, fromQueue: Boolean(state.uploadQueue?.active) });
  }

  function expectedProductTitlesForQueue(queue) {
    return (queue?.items || []).map(item => item?.titulo || item?.nome).filter(Boolean);
  }

  function collectProductListText() {
    const tables = [...document.querySelectorAll("table")].filter(visible);
    const source = tables.length ? tables.map(table => table.innerText || table.textContent || "").join(" ") : document.body.innerText;
    return normalizeText(source);
  }

  async function verifyQueueProductsOnList(queue) {
    await waitFor(() => document.querySelector("table") || byText("button, a", "Criar produto"), "lista de produtos");
    await sleep(1500);

    if (productListIsEmpty()) {
      return expectedProductTitlesForQueue(queue);
    }

    const tableText = collectProductListText();
    const missing = expectedProductTitlesForQueue(queue).filter(title => !tableText.includes(normalizeText(title)));
    if (missing.length) {
      consoleExecuting("Produtos ainda nao apareceram na tabela, aguardando nova leitura", { missing });
      await sleep(2500);
      const refreshedText = collectProductListText();
      return missing.filter(title => !refreshedText.includes(normalizeText(title)));
    }
    return [];
  }

  function getNextMainItemAfterQueue(queue) {
    const startIndex = Number.isInteger(queue?.sourceIndex)
      ? queue.sourceIndex
      : state.items.findIndex(item => String(item?.id || item?.titulo) === String(queue?.mainId || queue?.mainTitle));
    return state.items[startIndex + 1] || null;
  }

  function findNextMainItemWithMissing(startIndex = 0) {
    for (let index = Math.max(0, startIndex); index < state.items.length; index += 1) {
      const item = state.items[index];
      const missing = getMissingUploadItemsFromList(item);
      if (missing.length) return item;
    }
    return null;
  }

  async function startNextQueueFromProducts(mainItem) {
    const queue = ensureUploadQueue(mainItem);
    if (!queue.active) {
      const nextMainItem = getNextMainItemAfterQueue(queue);
      if (nextMainItem) {
        await startNextQueueFromProducts(nextMainItem);
      } else {
        log("Todos os itens com subir=true foram confirmados na lista.");
      }
      return;
    }

    state.selected = currentQueueItem() || mainItem;
    queue.autoContinue = false;
    saveUploadQueue(queue);
    log(`Iniciando indice ${queue.sourceIndex + 1}: ${state.selected?.titulo || state.selected?.nome}`);
    await sleep(1000);
    await clickCreateProductOnList();
  }

  async function continueQueueAfterNavigation() {
    state.uploadQueue = loadUploadQueue();
    if (!/\/products\/?$/.test(window.location.pathname)) return;

    await waitFor(() => findProductsTable() || byText("button, a, div", "Criar produto"), "lista inicial de produtos");
    if (productListIsEmpty()) {
      if (state.uploadQueue?.active) {
        log("Tabela inicial vazia. Limpando fila antiga e recomecando todos os produtos.");
        saveUploadQueue({ active: false });
      }
      if (state.items[0]) {
        await startNextQueueFromProducts(state.items[0]);
      }
      return;
    }

    if (!state.uploadQueue?.active) {
      const nextMissing = findNextMainItemWithMissing(0);
      if (nextMissing) {
        log(`Fila inativa, mas ha produtos faltantes. Iniciando: ${nextMissing.titulo || nextMissing.nome}`);
        await startNextQueueFromProducts(nextMissing);
      }
      return;
    }
    if (!state.uploadQueue.autoContinue && state.uploadQueue.phase === "verify") return;

    if (state.uploadQueue.phase === "verify") {
      const queue = state.uploadQueue;
      log(`Verificando na tabela: ${expectedProductTitlesForQueue(queue).join(" | ")}`);
      const missing = await verifyQueueProductsOnList(queue);
      if (missing.length) {
        queue.autoContinue = false;
        saveUploadQueue(queue);
        log(`Ainda nao encontrei na lista: ${missing.join(" | ")}. Recarregue/filtre a lista e rode novamente.`);
        return;
      }

      log(`Grupo confirmado na tabela: ${queue.mainTitle || queue.mainId}`);
      const nextMainItem = getNextMainItemAfterQueue(queue);
      if (!nextMainItem) {
        saveUploadQueue({ active: false });
        log("Todos os itens com subir=true foram confirmados na lista.");
        return;
      }

      saveUploadQueue({ active: false });
      await startNextQueueFromProducts(nextMainItem);
      return;
    }

    state.uploadQueue = reconcileQueueWithProductsTable(state.uploadQueue, currentQueueItem());
    if (!state.uploadQueue?.active) {
      const nextMissing = findNextMainItemWithMissing(0);
      if (nextMissing) await startNextQueueFromProducts(nextMissing);
      return;
    }
    state.uploadQueue.autoContinue = false;
    saveUploadQueue(state.uploadQueue);
    state.selected = currentQueueItem();
    log(`Continuando fila automaticamente: ${state.selected?.titulo || state.selected?.nome}`);
    await sleep(1800);
    await clickCreateProductOnList();
  }

  function wireCreateProductAutoStart() {
    const handleCreateProductEvent = event => {
      const button = findClickableAncestor(event.target);
      if (!isCreateProductButton(button) || state.running) return;

      consoleExecuting("Evento detectado no botao Criar produto da Kiwify", { type: event.type });
      setTimeout(() => {
        startFromCreateProductTrigger(`evento:${event.type}`);
      }, 100);
    };

    ["pointerdown", "mousedown", "click"].forEach(eventName => {
      document.addEventListener(eventName, handleCreateProductEvent, true);
    });

    const observer = new MutationObserver(() => {
      if (!findCreateProductDialog() || state.running) return;
      startFromCreateProductTrigger("modal:criar-produto-visivel");
    });

    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "aria-hidden"]
    });

    consoleSuccess("Gatilhos do botao Criar produto configurados");
  }

  function renderPanel() {
    document.getElementById("gp-kiwify-panel")?.remove();
  }

  resetAutomationStateIfRequested();
  renderPanel();
  wireCreateProductAutoStart();
  loadSubirJson()
    .then(() => continueQueueAfterNavigation())
    .catch(error => {
    log(`Não consegui ler subir.json ainda: ${error.message}`);
    log("Inicie um servidor local na pasta do projeto. Exemplo: npx http-server . -p 8787 --cors");
  });
})();
