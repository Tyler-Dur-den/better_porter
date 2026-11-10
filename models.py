from sqlalchemy import Column, Integer, String, Enum
from database import Base
import enum
from sqlalchemy import Column, Integer, String, Float, Enum, ForeignKey

class RoleType(enum.Enum):
    USER = "user"
    DRIVER = "driver"

class Account(Base):
    __tablename__ = "accounts"
    
    id = Column(Integer, primary_key=True, index=True)
    phone = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    role = Column(Enum(RoleType), nullable=False)

class Ride(Base):
    __tablename__ = "rides"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("accounts.id"))
    driver_id = Column(Integer, ForeignKey("accounts.id"), nullable=True)
    pickup_lat = Column(Float)
    pickup_lng = Column(Float)
    dropoff_lat = Column(Float)
    dropoff_lng = Column(Float)
    vehicle_type = Column(String)
    price = Column(Float)
    status = Column(String, default="PENDING") # PENDING, ACCEPTED, COMPLETED