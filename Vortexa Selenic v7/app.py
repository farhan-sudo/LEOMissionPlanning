from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from skyfield.api import EarthSatellite, load, wgs84
from datetime import datetime, timezone, timedelta
from geopy.distance import geodesic
import numpy as np
import os

# --- NEW IMPORTS for Population Map ---
import math
import rasterio
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
import cartopy.feature as cfeature
from rasterio.features import geometry_mask
from shapely.geometry import mapping
from geopy.distance import great_circle
# Initialize Flask App
app = Flask(__name__)
CORS(app)

# --- TLE Data ---
tle_lines = [
    "ISS (ZARYA)",
    "1 25544U 98067A   25277.51233796  .00016717  00000-0  30327-3 0  9993",
    "2 25544  51.6416 255.4363 0006753 133.5855 226.5447 15.49479347343467"
]

# --- Skyfield Setup ---
ts = load.timescale()
satellite = EarthSatellite(tle_lines[1], tle_lines[2], tle_lines[0], ts)
tle_epoch = satellite.epoch.utc_datetime()

# --- Global Data Loading ---
# CORRECTED: Define a single, consistent path for the TIF file.
# Make sure your TIF file is inside a 'population_map' folder next to your app.py
TIF_FILE_PATH = os.path.join("population_map", "gpw_v4_2020.tif")

# Load the pre-processed population count data once when the server starts
POPULATION_COUNT_DATA = np.load("population_count.npy")
with rasterio.open(TIF_FILE_PATH) as src:
    RASTER_TRANSFORM = src.transform
    RASTER_SHAPE = (src.height, src.width)

# --- Helper Function for Spotbeam ---
def calculate_spotbeam_polygon(center_lat, center_lon, radius_km, num_points=50):
    g = geodesic()
    polygon_points = []
    for i in range(num_points):
        bearing = i * (360 / num_points)
        dest_point = g.destination(point=(center_lat, center_lon), bearing=bearing, distance=radius_km)
        polygon_points.append([dest_point.longitude, dest_point.latitude])
    polygon_points.append(polygon_points[0])
    return polygon_points

@app.route('/api/position')
def get_position():
    try:
        elapsed_seconds = float(request.args.get('elapsed_seconds', '0'))
        spotbeam_radius_km = float(request.args.get('radius_km', '1000'))
        sim_time = tle_epoch + timedelta(seconds=elapsed_seconds)
        skyfield_time = ts.from_datetime(sim_time)
        geocentric = satellite.at(skyfield_time)
        subpoint = wgs84.subpoint(geocentric)
        spotbeam_polygon = calculate_spotbeam_polygon(subpoint.latitude.degrees, subpoint.longitude.degrees, spotbeam_radius_km)
        return jsonify({
            'simulation_time_iso': sim_time.isoformat(),
            'elapsed_seconds': elapsed_seconds,
            'latitude': subpoint.latitude.degrees,
            'longitude': subpoint.longitude.degrees,
            'spotbeam_polygon': spotbeam_polygon
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- NEW ENDPOINT for Population Density Map ---
@app.route('/api/population-density')
def generate_population_map():
    output_filename = "population_density_map.png"
    # Create static/textures directory if it doesn't exist
    textures_dir = os.path.join('static', 'textures')
    if not os.path.exists(textures_dir):
        os.makedirs(textures_dir)
    
    output_path = os.path.join(textures_dir, output_filename)
    
    if not os.path.exists(output_path):
        try:
            with rasterio.open(TIF_FILE_PATH) as src:
                data = src.read(1)
                transform = src.transform
                extent = (src.bounds.left, src.bounds.right, src.bounds.bottom, src.bounds.top)
            
            # Roll the data array to shift from [-180,180] to [0,360] mapping
            cols = data.shape[1]
            roll_amount = cols // 2
            data = np.roll(data, roll_amount, axis=1)
            
            land_feature = cfeature.NaturalEarthFeature("physical", "land", scale="110m")
            land_geoms = [mapping(geom) for geom in land_feature.geometries()]
            land_mask = geometry_mask(land_geoms, transform=transform, invert=True, out_shape=data.shape)
            
            # Roll the land mask too
            land_mask = np.roll(land_mask, roll_amount, axis=1)

            data_land = np.where(land_mask, data, -9999)
            data_log = np.log10(1 + data_land)
            
            cmap = plt.get_cmap('plasma')
            cmap.set_under(alpha=0)
            
            fig = plt.figure(figsize=(12, 6), dpi=200)
            ax = plt.axes([0,0,1,1], projection=ccrs.PlateCarree())
            
            # Update extent to [0, 360] range
            new_extent = (0, 360, extent[2], extent[3])
            ax.set_extent(new_extent, crs=ccrs.PlateCarree())

            ax.imshow(
                data_log,
                origin="upper",
                extent=new_extent,
                transform=ccrs.PlateCarree(),
                cmap=cmap,
                vmin=0.1
            )
            plt.savefig(output_path, transparent=True, bbox_inches='tight', pad_inches=0)
            plt.close(fig)
        except Exception as e:
            return jsonify({'error': f"Failed to generate map: {str(e)}"}), 500
    
    # Return the correct path with forward slashes
    return jsonify({'map_url': f'/static/textures/{output_filename}'})

# --- Route to serve static files ---
@app.route('/static/<path:filename>')
def serve_static(filename):
    return send_from_directory('static', filename)

# --- NEW ENDPOINT for Population Estimation ---
@app.route('/api/population-estimate')
def get_population_estimate():
    try:
        lat = float(request.args.get('lat'))
        lon = float(request.args.get('lon'))
        radius_km = float(request.args.get('radius_km', 1))
        # Convert lat/lon to pixel row/col
        center_col, center_row = ~RASTER_TRANSFORM * (lon, lat)
        center_col, center_row = int(center_col), int(center_row)
        # Estimate pixel radius based on latitude
        km_per_deg_lat = 111.0
        km_per_deg_lon = 111.32 * math.cos(math.radians(lat))

        pixel_width_deg = RASTER_TRANSFORM.a
        pixel_height_deg = abs(RASTER_TRANSFORM.e)

        col_radius = 1
        if km_per_deg_lon > 0:
            col_radius = max(1, round(radius_km / (km_per_deg_lon * pixel_width_deg)))

        row_radius = max(1, round(radius_km / (km_per_deg_lat * pixel_height_deg)))
        # Define the slice for the area of interest, clamping to array bounds
        row_start = max(0, center_row - row_radius)
        row_stop = min(RASTER_SHAPE[0], center_row + row_radius + 1)
        col_start = max(0, center_col - col_radius)
        col_stop = min(RASTER_SHAPE[1], center_col + col_radius + 1)
        # Slice the pre-computed population count data and sum it up
        area_slice = POPULATION_COUNT_DATA[row_start:row_stop, col_start:col_stop]
        population_in_radius = np.nansum(area_slice)
        return jsonify({
            'latitude': lat,
            'longitude': lon,
            'radius_km': radius_km,
            'estimated_population': int(population_in_radius)
        })
    except Exception as e:
        # Don't return error 500 for out-of-bounds clicks, just return empty
        return jsonify({'estimated_population': 0})

@app.route('/api/coverage-score')
def get_coverage_score():
    try:
        spotbeam_radius_km = 1300 # Standard spotbeam for this calculation
        # 1. Calculate orbital period from TLE mean motion
        mean_motion_revs_per_day = float(tle_lines[2][52:63])
        period_seconds = (24 * 60 * 60) / mean_motion_revs_per_day
        # 2. Simulate orbit and collect all unique covered pixels
        covered_pixels = set()
        time_step_seconds = 10 # More steps = more accuracy, slower calculation
        for t in np.arange(0, period_seconds, time_step_seconds):
            sim_time = tle_epoch + timedelta(seconds=t)
            skyfield_time = ts.from_datetime(sim_time)
            geocentric = satellite.at(skyfield_time)
            subpoint = wgs84.subpoint(geocentric)

            lat, lon = subpoint.latitude.degrees, subpoint.longitude.degrees

            # This logic is similar to the hover estimate but adapted for the spotbeam
            center_point = (lat, lon)
            center_col, center_row = ~RASTER_TRANSFORM * (lon, lat)
            center_col, center_row = int(center_col), int(center_row)

            # Define bounding box
            km_per_deg_lat = 111.0
            km_per_deg_lon = 111.32 * math.cos(math.radians(lat))
            col_radius = max(1, round(spotbeam_radius_km / (km_per_deg_lon * RASTER_TRANSFORM.a)))
            row_radius = max(1, round(spotbeam_radius_km / (km_per_deg_lat * abs(RASTER_TRANSFORM.e))))

            row_start = max(0, center_row - row_radius)
            row_stop = min(RASTER_SHAPE[0], center_row + row_radius + 1)
            col_start = max(0, center_col - col_radius)
            col_stop = min(RASTER_SHAPE[1], center_col + col_radius + 1)
            # Check pixels in bounding box and add to set if they are in the circle
            for r in range(row_start, row_stop):
                for c in range(col_start, col_stop):
                    pixel_lon, pixel_lat = RASTER_TRANSFORM * (c + 0.5, r + 0.5)
                    distance = great_circle(center_point, (pixel_lat, pixel_lon)).kilometers
                    if distance <= spotbeam_radius_km:
                        covered_pixels.add((r, c))
        # 3. Sum population for all unique pixels
        total_population = sum(POPULATION_COUNT_DATA[r, c] for r, c in covered_pixels)

        return jsonify({'coverage_score': int(total_population)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    if not os.path.exists('static'):
        os.makedirs('static')
    app.run(debug=True, port=5000)