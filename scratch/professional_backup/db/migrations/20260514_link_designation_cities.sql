-- Create designation_cities junction table
CREATE TABLE IF NOT EXISTS public.designation_cities (
    designation_id INTEGER NOT NULL REFERENCES public.designation(designation_id) ON DELETE CASCADE,
    city_id INTEGER NOT NULL REFERENCES public.cities(city_id) ON DELETE CASCADE,
    PRIMARY KEY (designation_id, city_id)
);

-- Index for faster filtering
CREATE INDEX IF NOT EXISTS idx_designation_cities_city_id ON public.designation_cities(city_id);
CREATE INDEX IF NOT EXISTS idx_designation_cities_designation_id ON public.designation_cities(designation_id);
