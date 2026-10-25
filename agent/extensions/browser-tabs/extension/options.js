const $ = (id) => document.getElementById(id);

chrome.storage.local.get({ token: "", port: 17420, allowAll: false }).then((s) => {
	$("token").value = s.token;
	$("port").value = s.port;
	$("allowAll").checked = s.allowAll;
});

$("save").addEventListener("click", async () => {
	await chrome.storage.local.set({
		token: $("token").value.trim(),
		port: Number($("port").value) || 17420,
		allowAll: $("allowAll").checked,
	});
	$("status").textContent = "Saved";
	setTimeout(() => ($("status").textContent = ""), 1500);
});
