from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime, timedelta
from passlib.context import CryptContext
from jose import jwt
from fastapi import WebSocket, WebSocketDisconnect
import json
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError
# (Keep your other existing imports: FastAPI, Depends, etc.)
import models
from database import engine, get_db
import math

def fetch_route_details(lat1: float, lon1: float, lat2: float, lon2: float):
    """Calculates approximate road distance and ETA using local math."""
    R = 6371.0  # Radius of the Earth in kilometers

    # Convert coordinates to radians
    lat1_rad = math.radians(lat1)
    lon1_rad = math.radians(lon1)
    lat2_rad = math.radians(lat2)
    lon2_rad = math.radians(lon2)

    # Differences in coordinates
    dlon = lon2_rad - lon1_rad
    dlat = lat2_rad - lat1_rad

    # Haversine formula
    a = math.sin(dlat / 2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    straight_line_distance = R * c
    
    # 1. Estimate actual road distance (multiply by 1.35 for city blocks)
    distance_km = straight_line_distance * 1.35
    
    # 2. Estimate ETA (Assuming 20 km/h average city traffic speed)
    eta_mins = (distance_km / 20.0) * 60.0
    
    return distance_km, eta_mins
# Create the database tables
models.Base.metadata.create_all(bind=engine)

app = FastAPI()

# Allow your frontend (Live Server) to make requests to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, restrict this to your frontend domain
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Security Configuration ---
SECRET_KEY = "your-super-secret-development-key"
ALGORITHM = "HS256"
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_password_hash(password):
    return pwd_context.hash(password)

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(days=7)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

# --- Pydantic Schemas ---
class AccountCreate(BaseModel):
    phone: str
    password: str
    role: str # "user" or "driver"

class LoginRequest(BaseModel):
    phone: str
    password: str

# --- JWT Dependency ---
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")

def get_current_account(token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        phone: str = payload.get("sub")
        account_id: int = payload.get("id")
        role: str = payload.get("role")
        
        if phone is None or account_id is None:
            raise HTTPException(status_code=401, detail="Invalid token payload")
            
        return {"id": account_id, "phone": phone, "role": role}
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

# --- Endpoints ---

@app.post("/register")
def register(account: AccountCreate, db: Session = Depends(get_db)):
    # Check if user already exists
    existing_user = db.query(models.Account).filter(models.Account.phone == account.phone).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Phone number already registered")
    
    # Hash password and create user
    hashed_pw = get_password_hash(account.password)
    role_enum = models.RoleType.USER if account.role.lower() == "user" else models.RoleType.DRIVER
    
    new_account = models.Account(phone=account.phone, hashed_password=hashed_pw, role=role_enum)
    db.add(new_account)
    db.commit()
    db.refresh(new_account)
    return {"message": "Account created successfully"}

@app.post("/login")
def login(request: LoginRequest, db: Session = Depends(get_db)):
    account = db.query(models.Account).filter(models.Account.phone == request.phone).first()
    
    if not account or not verify_password(request.password, account.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect phone number or password")
    
    token = create_access_token({"sub": account.phone, "id": account.id, "role": account.role.value})
    return {"access_token": token, "token_type": "bearer", "role": account.role.value}

# --- Real-Time Tracking (WebSockets) ---

class ConnectionManager:
    def __init__(self):
        # Dictionary mapping ride_id to a list of active WebSocket connections
        self.active_connections: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, ride_id: str):
        await websocket.accept()
        if ride_id not in self.active_connections:
            self.active_connections[ride_id] = []
        self.active_connections[ride_id].append(websocket)

    def disconnect(self, websocket: WebSocket, ride_id: str):
        if ride_id in self.active_connections:
            self.active_connections[ride_id].remove(websocket)
            if not self.active_connections[ride_id]:
                del self.active_connections[ride_id]

    async def broadcast(self, message: str, ride_id: str, sender: WebSocket):
        """Sends a message to all clients connected to a specific ride, except the sender."""
        for connection in self.active_connections.get(ride_id, []):
            if connection != sender:
                await connection.send_text(message)

manager = ConnectionManager()

@app.websocket("/ws/tracking/{ride_id}")
async def tracking_endpoint(websocket: WebSocket, ride_id: str):
    await manager.connect(websocket, ride_id)
    try:
        while True:
            # Wait for coordinates from the Driver
            data = await websocket.receive_text()
            
            # Instantly broadcast those coordinates to the User
            await manager.broadcast(data, ride_id, sender=websocket)
            
    except WebSocketDisconnect:
        manager.disconnect(websocket, ride_id)
# --- Pydantic Schemas for Pricing ---
class QuoteRequest(BaseModel):
    pickup_lat: float
    pickup_lng: float
    dropoff_lat: float
    dropoff_lng: float
    vehicle_type: str  # "bike" or "truck"

# --- Secure Endpoints ---

@app.post("/api/v1/rides/quote")
def get_price_quote(request: QuoteRequest, account: dict = Depends(get_current_account)):
    # 1. Use the live coordinates to calculate real distance
    distance_km, eta_mins = fetch_route_details(
        request.pickup_lat, request.pickup_lng, 
        request.dropoff_lat, request.dropoff_lng
    )
    
    # 2. Base Matrix Configuration
    pricing_matrix = {
        "bike": {"base": 48, "base_km": 1, "base_min": 25, "per_km": 10, "per_min": 1.5},
        "truck": {"base": 194, "base_km": 2, "base_min": 40, "per_km": 20, "per_min": 3}
    }
    
    if request.vehicle_type not in pricing_matrix:
        raise HTTPException(status_code=400, detail="Invalid vehicle type")
        
    rates = pricing_matrix[request.vehicle_type]
    surge_multiplier = 1.0 
    
    # 3. Math Calculation
    extra_dist = max(0, distance_km - rates["base_km"])
    extra_time = max(0, eta_mins - rates["base_min"])
    
    total_fare = (rates["base"] + (extra_dist * rates["per_km"]) + (extra_time * rates["per_min"])) * surge_multiplier
    
    # 4. Tax Breakdown
    subtotal = round(total_fare, 2)
    tax = round(subtotal * 0.18, 2)
    grand_total = round(subtotal + tax, 2)
    
    return {
        "subtotal": subtotal,
        "tax": tax,
        "grand_total": grand_total,
        "distance_km": round(distance_km, 2),
        "eta_mins": round(eta_mins, 1)
    }

class RideCreate(BaseModel):
    pickup_lat: float
    pickup_lng: float
    dropoff_lat: float
    dropoff_lng: float
    vehicle_type: str
    price: float

@app.post("/api/v1/rides/book")
def book_ride(ride: RideCreate, db: Session = Depends(get_db), account: dict = Depends(get_current_account)):
    if account["role"] != "user":
        raise HTTPException(status_code=403, detail="Only users can book rides")
        
    new_ride = models.Ride(
        user_id=account["id"],
        pickup_lat=ride.pickup_lat,
        pickup_lng=ride.pickup_lng,
        dropoff_lat=ride.dropoff_lat,
        dropoff_lng=ride.dropoff_lng,
        vehicle_type=ride.vehicle_type,
        price=ride.price,
        status="PENDING"
    )
    db.add(new_ride)
    db.commit()
    db.refresh(new_ride)
    
    return {"message": "Ride requested successfully!", "ride_id": new_ride.id}

# ==========================================
# DRIVER ENDPOINTS
# ==========================================

@app.get("/api/v1/rides/pending")
def get_pending_rides(db: Session = Depends(get_db), account: dict = Depends(get_current_account)):
    # Security check: only drivers can see this list
    if account["role"] != "driver":
        raise HTTPException(status_code=403, detail="Only drivers can view pending rides")
        
    # Fetch all rides waiting for a driver
    pending_rides = db.query(models.Ride).filter(models.Ride.status == "PENDING").all()
    return pending_rides

@app.post("/api/v1/rides/{ride_id}/accept")
def accept_ride(ride_id: int, db: Session = Depends(get_db), account: dict = Depends(get_current_account)):
    # Security check
    if account["role"] != "driver":
        raise HTTPException(status_code=403, detail="Only drivers can accept rides")
        
    # Find the specific ride in the database
    ride = db.query(models.Ride).filter(models.Ride.id == ride_id).first()
    
    if not ride:
        raise HTTPException(status_code=404, detail="Ride not found")
    if ride.status != "PENDING":
        raise HTTPException(status_code=400, detail="Ride is no longer available")
        
    # Lock the ride to this specific driver
    ride.status = "ACCEPTED"
    ride.driver_id = account["id"]
    
    db.commit()
    
    return {"message": "Ride accepted successfully", "ride_id": ride.id}