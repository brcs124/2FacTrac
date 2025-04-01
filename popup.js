// popup.js

const codeDisplay = document.getElementById('code-display');
const copyButton = document.getElementById('copy-button');
const statusDiv = document.getElementById('status');
const senderInfo = document.getElementById('sender-info');

// Function to display the code and update button state
function displayCode(code, sender) {
    if (code) {
        codeDisplay.textContent = code;
        copyButton.disabled = false;
        statusDiv.textContent = 'Code found.';
        
        // Display sender information if available
        if (sender) {
            senderInfo.textContent = `From: ${sender}`;
            senderInfo.style.display = 'block';
        } else {
            senderInfo.style.display = 'none';
        }
    } else {
        codeDisplay.textContent = 'N/A';
        copyButton.disabled = true;
        statusDiv.textContent = 'No code found or still checking.';
        senderInfo.style.display = 'none';
    }
}

// --- Request Code on Popup Open ---
console.log("Popup requesting fresh code check from background.");
statusDiv.textContent = 'Requesting check...';
chrome.runtime.sendMessage({ type: "triggerFetchAndGetCode" }, (response) => {
    if (chrome.runtime.lastError) {
        console.error("Error getting code:", chrome.runtime.lastError);
        displayCode(null, null);
        statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
    } else if (response) {
        console.log("Popup received response:", response);
        displayCode(response.code, response.sender);
    } else {
        console.log("Popup received empty response from background.");
        displayCode(null, null);
        statusDiv.textContent = 'Background script might be inactive or no code available.';
    }
});

// --- Copy Button Listener ---
copyButton.addEventListener('click', () => {
    const codeToCopy = codeDisplay.textContent;
    if (codeToCopy && codeToCopy !== 'N/A' && codeToCopy !== 'Loading...') {
        navigator.clipboard.writeText(codeToCopy)
            .then(() => {
                console.log('Code copied to clipboard:', codeToCopy);
                statusDiv.textContent = 'Copied!';
                // Briefly change button text or style (optional)
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy';
                    // Reset status message after a bit longer
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

// --- Listen for Updates from Background (Optional but recommended) ---
// If the background finds a new code while the popup is open
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'newCodeFound' && message.code) {
        console.log("Popup received new code update:", message.code);
        displayCode(message.code, message.sender);
        statusDiv.textContent = 'New code arrived!';
    }
});

console.log("Popup script loaded.");