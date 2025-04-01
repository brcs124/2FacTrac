// popup.js

const codeDisplay = document.getElementById('code-display');
const copyButton = document.getElementById('copy-button');
const refreshButton = document.getElementById('refresh-button');
const statusDiv = document.getElementById('status');
const senderInfo = document.getElementById('sender-info');
const linkContainer = document.getElementById('link-container');
const verificationLink = document.getElementById('verification-link');
const openLinkButton = document.getElementById('open-link-button');
const linkSection = document.getElementById('link-section');

// Function to display the code, link, and update UI
function displayVerificationInfo(code, link, sender) {
    // Handle verification code display
    if (code) {
        codeDisplay.textContent = code;
        copyButton.disabled = false;
        statusDiv.textContent = 'Code found.';
    } else {
        codeDisplay.textContent = 'N/A';
        copyButton.disabled = true;
    }
    
    // Handle verification link display
    if (link) {
        verificationLink.textContent = link;
        verificationLink.href = link;
        linkContainer.style.display = 'block';
        openLinkButton.disabled = false;
        linkSection.style.display = 'block';
    } else {
        linkContainer.style.display = 'none';
        openLinkButton.disabled = true;
        
        // Optional: hide the entire link section if no link found
        // linkSection.style.display = 'none';
    }
    
    // Handle sender information display
    if (sender) {
        senderInfo.textContent = `From: ${sender}`;
        senderInfo.style.display = 'block';
    } else {
        senderInfo.style.display = 'none';
    }
    
    // Status message if nothing found
    if (!code && !link) {
        statusDiv.textContent = 'No verification info found.';
    }
}

// --- Request Code and Link on Popup Open ---
function fetchVerificationInfo() {
    console.log("Requesting fresh verification check from background.");
    statusDiv.textContent = 'Requesting check...';
    codeDisplay.textContent = 'Loading...';
    chrome.runtime.sendMessage({ type: "triggerFetchAndGetCode" }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Error getting verification info:", chrome.runtime.lastError);
            displayVerificationInfo(null, null, null);
            statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
        } else if (response) {
            console.log("Popup received response:", response);
            displayVerificationInfo(response.code, response.link, response.sender);
        } else {
            console.log("Popup received empty response from background.");
            displayVerificationInfo(null, null, null);
            statusDiv.textContent = 'Background script might be inactive.';
        }
    });
}

// Initial fetch
fetchVerificationInfo();

// --- Copy Button Listener ---
copyButton.addEventListener('click', () => {
    const codeToCopy = codeDisplay.textContent;
    if (codeToCopy && codeToCopy !== 'N/A' && codeToCopy !== 'Loading...') {
        navigator.clipboard.writeText(codeToCopy)
            .then(() => {
                console.log('Code copied to clipboard:', codeToCopy);
                statusDiv.textContent = 'Copied!';
                // Briefly change button text or style
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                    // Reset status message after a bit
                    setTimeout(() => {
                        statusDiv.textContent = 'Code found.';
                    }, 500);
                }, 1500);
            })
            .catch(err => {
                console.error('Failed to copy code:', err);
                statusDiv.textContent = 'Copy failed!';
            });
    }
});

// --- Refresh Button Listener ---
refreshButton.addEventListener('click', () => {
    fetchVerificationInfo();
});

// --- Open Link Button Listener ---
openLinkButton.addEventListener('click', () => {
    if (verificationLink.href) {
        // Open the link in a new tab
        chrome.tabs.create({ url: verificationLink.href });
    }
});

// --- Listen for Updates from Background ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'newCodeFound') {
        console.log("Popup received verification update:", message);
        displayVerificationInfo(message.code, message.link, message.sender);
        statusDiv.textContent = 'New verification info arrived!';
    }
});

console.log("Popup script loaded.");