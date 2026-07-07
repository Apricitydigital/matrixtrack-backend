-- Create department_cities junction table
CREATE TABLE IF NOT EXISTS public.department_cities (
    department_id INTEGER NOT NULL REFERENCES public.department(department_id) ON DELETE CASCADE,
    city_id INTEGER NOT NULL REFERENCES public.cities(city_id) ON DELETE CASCADE,
    PRIMARY KEY (department_id, city_id)
);

-- Index for faster filtering
CREATE INDEX IF NOT EXISTS idx_department_cities_city_id ON public.department_cities(city_id);
CREATE INDEX IF NOT EXISTS idx_department_cities_department_id ON public.department_cities(department_id);
