// ==========================================
// 0. AUTHENTICATION LOGIC (API Fetch)
// ==========================================
const API_BASE_URL = "http://127.0.0.1:8000";

const authContainer = document.getElementById('auth-container');
const appContainer = document.getElementById('app-container');
const authMessage = document.getElementById('auth-message');

document.getElementById('btn-register').addEventListener('click', async () => {
    const phone = document.getElementById('auth-phone').value;
    const password = document.getElementById('auth-password').value;
    const role = document.getElementById('auth-role').value;

    try {
        const response = await fetch(`${API_BASE_URL}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password, role })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            authMessage.style.color = "green";
            authMessage.innerText = "Registration successful! Please login.";
        } else {
            authMessage.style.color = "red";
            authMessage.innerText = data.detail || "Registration failed";
        }
    } catch (error) {
        authMessage.innerText = "Server connection error.";
    }
});

document.getElementById('btn-login').addEventListener('click', async () => {
    const phone = document.getElementById('auth-phone').value;
    const password = document.getElementById('auth-password').value;

    try {
        const response = await fetch(`${API_BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            localStorage.setItem('access_token', data.access_token);
            localStorage.setItem('role', data.role);
            
            authContainer.style.display = 'none';
            appContainer.style.display = 'flex';
            
            setTimeout(() => { map.invalidateSize(); }, 100);
            
            document.querySelector('.role-selector').style.display = 'none';
            document.querySelector('header h1').innerText = `Delivery Portal - ${data.role.toUpperCase()}`;
            
            // ---> UPDATE THIS ROUTING LOGIC <---
            if (data.role === 'driver') {
                document.getElementById('controls').style.display = 'none'; // Hide user fare estimator
                document.getElementById('driver-dashboard').style.display = 'block'; // Show driver feed
                fetchPendingRides();
            } else {
                document.getElementById('controls').style.display = 'block';
                document.getElementById('driver-dashboard').style.display = 'none';
            }
            
            startWebSocket(data.role);
        } else {
            authMessage.style.color = "red";
            authMessage.innerText = data.detail || "Login failed";
        }
    } catch (error) {
        authMessage.innerText = "Server connection error.";
    }
});

// ==========================================
// 1. MAP INITIALIZATION & UI
// ==========================================
const map = L.map('map').setView([12.9716, 77.5946], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let driverMarker = L.marker([12.9716, 77.5946]).addTo(map).bindPopup("Driver Location").openPopup();

const pickupMarker = L.marker([12.9716, 77.5946], { draggable: true, title: "Pickup" })
    .addTo(map).bindPopup("<b>Pickup</b><br>Drag me to your location").openPopup();

const dropoffMarker = L.marker([12.9352, 77.6245], { draggable: true, title: "Dropoff" })
    .addTo(map).bindPopup("<b>Dropoff</b><br>Drag me to your destination");

function updateLocationInputs() {
    const p = pickupMarker.getLatLng();
    const d = dropoffMarker.getLatLng();
    document.getElementById('pickup-loc').value = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
    document.getElementById('dropoff-loc').value = `${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}`;
}

const geocoder = L.Control.geocoder({
    defaultMarkGeocode: false,
    placeholder: "Search dropoff address..."
}).on('markgeocode', function(e) {
    const latlng = e.geocode.center;
    dropoffMarker.setLatLng(latlng);
    map.fitBounds(e.geocode.bbox);
    updateLocationInputs();
}).addTo(map);

document.getElementById('btn-gps').addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            pickupMarker.setLatLng([lat, lng]);
            map.panTo([lat, lng]);
            updateLocationInputs();
        }, () => alert("GPS permission denied."));
    }
});

pickupMarker.on('dragend', updateLocationInputs);
dropoffMarker.on('dragend', updateLocationInputs);
updateLocationInputs();

// ==========================================
// 2. WEBSOCKET TRACKING
// ==========================================
let ws = null;
let watchId = null;
let currentRideId = "ride_12345"; 

function startWebSocket(role) {
    if (ws) ws.close();
    if (watchId) navigator.geolocation.clearWatch(watchId);

    ws = new WebSocket(`ws://127.0.0.1:8000/ws/tracking/${currentRideId}`);

    ws.onopen = () => {
        console.log(`Connected to ride tracker as ${role}`);
        if (role === 'driver') {
            if (navigator.geolocation) {
                watchId = navigator.geolocation.watchPosition((pos) => {
                    const lat = pos.coords.latitude;
                    const lng = pos.coords.longitude;
                    driverMarker.setLatLng([lat, lng]);
                    map.panTo([lat, lng]);
                    ws.send(JSON.stringify({ lat, lng }));
                }, (err) => console.error("GPS Error:", err), { enableHighAccuracy: true, maximumAge: 0 });
            }
        }
    };

    ws.onmessage = (event) => {
        if (role === 'user') {
            const data = JSON.parse(event.data);
            if (data.lat && data.lng) {
                driverMarker.setLatLng([data.lat, data.lng]);
                map.panTo([data.lat, data.lng]); 
            }
        }
    };
}

// ==========================================
// 3. SECURE BACKEND PRICING & BOOKING
// ==========================================
let currentLockedPrice = 0;

document.getElementById('calc-btn').addEventListener('click', async () => {
    const vehicle = document.getElementById('vehicle').value;
    const token = localStorage.getItem('access_token');
    
    if (!token) {
        alert("You must be logged in to calculate a price.");
        return;
    }

    document.getElementById('price-error').innerText = `Calculating...`;
    document.getElementById('price-breakdown').style.display = 'none';
    document.getElementById('btn-confirm').style.display = 'none';

    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/rides/quote`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                pickup_lat: pickupMarker.getLatLng().lat,
                pickup_lng: pickupMarker.getLatLng().lng,
                dropoff_lat: dropoffMarker.getLatLng().lat,
                dropoff_lng: dropoffMarker.getLatLng().lng,
                vehicle_type: vehicle
            })
        });

        if (response.ok) {
            const data = await response.json();
            document.getElementById('bd-price').innerText = `₹${data.subtotal.toFixed(2)}`;
            document.getElementById('bd-tax').innerText = `₹${data.tax.toFixed(2)}`;
            document.getElementById('bd-total').innerText = `₹${data.grand_total.toFixed(2)}`;
            
            document.getElementById('price-breakdown').style.display = 'block';
            document.getElementById('price-error').innerText = '';
            document.getElementById('btn-confirm').style.display = 'block';
            
            currentLockedPrice = data.grand_total;
        } else {
            const err = await response.json();
            document.getElementById('price-error').innerText = `Error: ${err.detail}`;
        }
    } catch (error) {
        document.getElementById('price-error').innerText = "Server connection error.";
    }
});

document.getElementById('btn-confirm').addEventListener('click', async () => {
    const token = localStorage.getItem('access_token');
    const vehicle = document.getElementById('vehicle').value;
    const btn = document.getElementById('btn-confirm');
    
    btn.innerText = "Booking...";
    btn.disabled = true;

    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/rides/book`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                pickup_lat: pickupMarker.getLatLng().lat,
                pickup_lng: pickupMarker.getLatLng().lng,
                dropoff_lat: dropoffMarker.getLatLng().lat,
                dropoff_lng: dropoffMarker.getLatLng().lng,
                vehicle_type: vehicle,
                price: currentLockedPrice
            })
        });

        const data = await response.json();
        if (response.ok) {
            document.getElementById('booking-message').style.color = "green";
            document.getElementById('booking-message').innerText = "✅ Driver searching... (Ride ID: " + data.ride_id + ")";
            btn.style.display = 'none';
        } else {
            document.getElementById('booking-message').style.color = "red";
            document.getElementById('booking-message').innerText = data.detail;
            btn.innerText = "Confirm Booking";
            btn.disabled = false;
        }
    } catch (error) {
        document.getElementById('booking-message').innerText = "Server connection error.";
        btn.innerText = "Confirm Booking";
        btn.disabled = false;
    }
});
// ==========================================
// 4. DRIVER DASHBOARD LOGIC
// ==========================================

async function fetchPendingRides() {
    const token = localStorage.getItem('access_token');
    const ridesList = document.getElementById('rides-list');
    ridesList.innerHTML = "<em>Loading rides...</em>";

    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/rides/pending`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            const rides = await response.json();
            ridesList.innerHTML = ""; // Clear loading text

            if (rides.length === 0) {
                ridesList.innerHTML = "<p>No rides available right now.</p>";
                return;
            }

            // Create a card for each ride
            rides.forEach(ride => {
                const card = document.createElement('div');
                card.style.cssText = "border: 1px solid #e5e7eb; padding: 1rem; border-radius: 4px;";
                card.innerHTML = `
                    <p><strong>Type:</strong> ${ride.vehicle_type.toUpperCase()}</p>
                    <p><strong>Earnings:</strong> ₹${ride.price.toFixed(2)}</p>
                    <button onclick="acceptRide(${ride.id})" style="width: 100%; padding: 0.5rem; background: #2563eb; color: white; border: none; border-radius: 4px; margin-top: 0.5rem; cursor: pointer;">Accept Ride</button>
                `;
                ridesList.appendChild(card);
            });
        }
    } catch (error) {
        ridesList.innerHTML = "<p style='color: red;'>Failed to load rides.</p>";
    }
}

// Function triggered when driver clicks "Accept"
async function acceptRide(rideId) {
    const token = localStorage.getItem('access_token');
    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/rides/${rideId}/accept`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.ok) {
            alert(`Success! You have accepted Ride #${rideId}. Head to the pickup location.`);
            // Update current tracking ID to this real ride
            currentRideId = `ride_${rideId}`; 
            startWebSocket('driver');
            fetchPendingRides(); // Refresh list to remove accepted ride
        } else {
            const err = await response.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (error) {
        alert("Server connection error.");
    }
}

// Bind refresh button
document.getElementById('btn-refresh-rides').addEventListener('click', fetchPendingRides);