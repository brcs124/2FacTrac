// popup.js

const codeDisplay = document.getElementById('code-display');
const refreshButton = document.getElementById('refresh-button');
const statusDiv = document.getElementById('status');
const senderInfo = document.getElementById('sender-info');
const linkContainer = document.getElementById('link-container');
const verificationLink = document.getElementById('verification-link');
const openLinkButton = document.getElementById('open-link-button');
const linkSection = document.getElementById('link-section');
const copyToast = document.getElementById('copy-toast');

// Function to display the code, link, and update UI
function displayVerificationInfo(code, link, sender) {
    // Handle verification code display
    if (code) {
        codeDisplay.textContent = code;
        codeDisplay.dataset.code = code; // Store code for click-to-copy
    } else {
        codeDisplay.textContent = 'N/A';
        codeDisplay.dataset.code = null;
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
    }
    
    // Handle sender information display
    if (sender) {
        senderInfo.textContent = `From: ${sender}`;
        senderInfo.style.display = 'block';
    } else {
        senderInfo.style.display = 'none';
    }
}

// --- Click to copy functionality for code display ---
codeDisplay.addEventListener('click', () => {
    const code = codeDisplay.dataset.code;
    if (code && code !== 'N/A' && code !== 'Loading...') {
        navigator.clipboard.writeText(code)
            .then(() => {
                console.log('Code copied to clipboard:', code);
                
                // Show toast notification
                copyToast.classList.add('show');
                setTimeout(() => {
                    copyToast.classList.remove('show');
                }, 1500);
            })
            .catch(err => {
                console.error('Failed to copy code:', err);
            });
    }
});

// --- Request Code and Link on Popup Open ---
function fetchVerificationInfo() {
    console.log("Requesting fresh verification check from background.");
    codeDisplay.textContent = 'Loading...';
    
    // Add rotation animation to refresh button
    refreshButton.classList.add('rotating');
    
    chrome.runtime.sendMessage({ type: "triggerFetchAndGetCode" }, (response) => {
        // Remove the rotation animation
        setTimeout(() => {
            refreshButton.classList.remove('rotating');
        }, 1000);
        
        if (chrome.runtime.lastError) {
            console.error("Error getting verification info:", chrome.runtime.lastError);
            displayVerificationInfo(null, null, null);
        } else if (response) {
            console.log("Popup received response:", response);
            displayVerificationInfo(response.code, response.link, response.sender);
        } else {
            console.log("Popup received empty response from background.");
            displayVerificationInfo(null, null, null);
        }
    });
}

// Initial fetch
fetchVerificationInfo();

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
    }
});

console.log("Popup script loaded.");