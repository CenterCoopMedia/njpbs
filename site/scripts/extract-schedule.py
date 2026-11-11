#!/usr/bin/env python3
"""Read an approved monthly workbook, pinned by SHA-256, without changing it.

The sheet's three rows per half hour are layout, not ten-minute clock marks.
Only labeled half hours, explicit START AT notes, and verified PBS transitions
are accepted. Unresolved boundaries remain null for an explicitly labeled pair.
"""

import argparse
import calendar
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

SOURCES = {
    "f85fd189a0fb713b57331b5aa30875d4a2ca84cda86e9723a94580c3d2d9e52d": ("2026-10", "2026-10-14", 1140),
    "838d4231219e840647d8018261e165149d965b042b7cbb5be293631efc1c3a89": ("2026-11", "2026-11-02", 1128),
    "b79698acfe092fa9614167a6fcfff07e943f7b18eb9d31457c8dd0f49bbdf479": ("2026-12", "2026-11-09", 1148),
}
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
DAY_COLUMNS = ("B C D E F G H K L M N O P Q T U V W X Y Z AC AD AE AF AG AH AI AL AM AN AO AP AQ AR").split()
# Source spelling and wrapped titles map to their public program names.
PROGRAM_TITLES = {
    "RICK STEVES' EUROPE: A SYMPHONIC JOURNEY": "Rick Steves' Europe: A Symphonic Journey",
    "ARTHUR'S PERFECT CHRISTMAS": "Arthur's Perfect Christmas",
    "ARTHUR THANKSGIVING": "An Arthur Thanksgiving",
    "A CLASSIC CHRISTMAS: TIDINGS OF JOY WITH THE BACH FESTIVAL CHOIR & ORCHESTRA": "A Classic Christmas: Tidings of Joy With the Bach Festival Choir & Orchestra",
    "CLASSIC CHRISTMAS: TIDINGS OF JOY WITH THE BACH FESTIVAL CHOIR & ORCHESTRA": "A Classic Christmas: Tidings of Joy With the Bach Festival Choir & Orchestra",
    "THE ST. OLAF CHRISTMAS FESTIVAL: OUR HOPE FOR YEARS TO COME": "The St. Olaf Christmas Festival: Our Hope for Years to Come",
    "CAROLE KING & JAMES TAYLOR LIVE AT THE TROUBADOUR": "Carole King & James Taylor Live at the Troubadour",
    "BILLY JOEL: THE 100TH: LIVE FROM MADISON SQUARE GARDEN": "Billy Joel: The 100th: Live From Madison Square Garden",
    "GETTYSBURG BOOK: A FATHER, SON AND THE KILLER ANGELS": "Gettysburg Book: A Father, Son and the Killer Angels",
    "GETTYSBURG BOOK: A FATER, SON AND THE KILLER ANGELS": "Gettysburg Book: A Father, Son and the Killer Angels",
    "FLY BOYS: WESTERN PENNSYLVANIA'S TUSKEGEE AIRMEN:": "Fly Boys: Western Pennsylvania's Tuskegee Airmen",
    "THE COUNT OF MONTE CRISTO ON MASTERPIECE": "The Count of Monte Cristo on Masterpiece",
    "I LIED ABOUT MY AGE: A MARINE IN WORLD WAR II": "I Lied About My Age: A Marine in World War II",
    "DEBBIE GIBSON HOLIDAY: A SOUNDCHECK SPECIAL": "Debbie Gibson Holiday: A Soundcheck Special",
    "SAVING GEORGE WASHINTON'S MOUNT VERNON": "Saving George Washington's Mount Vernon",
    "NATIVE WATERS: A CHITMACHA (NAHM) RECOLLECTION": "Native Waters: A Chitmacha Recollection",
    "ACL PRESENTS: 25TH ANNUAL AMERICANA HONORS": "ACL Presents: 25th Annual Americana Honors",
    "DESTINATION LONDON: PREPARING FOR THE PARADE": "Destination London: Preparing for the Parade",
    "AN IRISH CHRISTMAS WITH MICHAEL LONDRA": "An Irish Christmas With Michael Londra",
    "SOUND THE BELLS: A HOLIDAY CELEBRATION": "Sound the Bells: A Holiday Celebration",
    "TUSKEGEE AIRMEN: RETURN TO RAMITELLI": "Tuskegee Airmen: Return to Ramitelli",
    "DOWNTON ABBEY SEASON 3 ON MASTERPIECE": "Downton Abbey on Masterpiece",
    "GRANTCHESTER SEASON 4 ON MASTERPIECE": "Grantchester on Masterpiece",
    "GRANTCHESTER SEASON 5 ON MASTERPIECE": "Grantchester on Masterpiece",
    "GRANTCHESTER: ON MASTERPIECE": "Grantchester on Masterpiece",
    "GRANTCHESTER ON MASTERPIECE": "Grantchester on Masterpiece",
    "LUCY WORSLEY'S KEYS TO THE CASTLE": "Lucy Worsley's Keys to the Castle",
    "HOME FOR THE HOLIDAYS: THE TEXAS TENORS": "Home for the Holidays: The Texas Tenors",
    "ANCIENT ROADS FROM CHRIST TO CONSTANTINE": "Ancient Roads From Christ to Constantine",
    "POWER TRIP: THE STORY OF ENERGY": "Power Trip: The Story of Energy",
    "SHRAPNEL DOWN: MY KOREAN WAR STORY": "Shrapnel Down: My Korean War Story",
    "REAL RAIL ADVENTURES: SWISS INTERNATIONAL HUBS": "Real Rail Adventures: Swiss International Hubs",
    "REAL RAIL ADVENTURES: SWISS GRAND TOUR": "Real Rail Adventures: Swiss Grand Tour",
    "REAL RAIL ADVENTURES: SWISS WINTER MAGIC": "Real Rail Adventures: Swiss Winter Magic",
    "REAL RAIL ADVENTURES: SWITZERLAND": "Real Rail Adventures: Switzerland",
    "BRYANT PARK NYC TREE LIGHTING 2006": "Bryant Park NYC Tree Lighting 2006",
    "FROZEN FRAMES: MURPHY'S YELLOWSTONE": "Frozen Frames: Murphy's Yellowstone",
    "TO THE ENDS OF THE EARTH: BIRDS OF EAST AFRICA": "To the Ends of the Earth: Birds of East Africa",
    "TO THE ENDS OF THE EARTH: EAST AFRICA": "To the Ends of the Earth: East Africa",
    "NATIVE BALL: LEGACY OF A TRAILBLAZER": "Native Ball: Legacy of a Trailblazer",
    "WILD KRATTS: A CREATURE CHRISTMAS": "Wild Kratts: A Creature Christmas",
    "WILD KRATTS: CREATURE CHRISTMAS": "Wild Kratts: A Creature Christmas",
    "LIFELINE: PEARL HARBOR'S UNKNOWN HERO": "Lifeline: Pearl Harbor's Unknown Hero",
    "MY MUSIC WITH RHIANNON GIDDENS": "My Music With Rhiannon Giddens",
    "JOURNEY HOME TO THE USS ARIZONA": "Journey Home to the USS Arizona",
    "EMMANUEL: A CONCORDIA CHRISTMAS": "Emmanuel: A Concordia Christmas",
    "MISS FISHER'S MURDER MYSTERIES": "Miss Fisher's Murder Mysteries",
    "MOONFLOWER MURDERS ON MASTERPIECE": "Moonflower Murders on Masterpiece",
    "MAGPIE MURDERS ON MASTERPIECE": "Magpie Murders on Masterpiece",
    "MISS AUSTEN ON MASTERPIECE": "Miss Austen on Masterpiece",
    "CHRISTIANITY AT A CROSSROADS": "Christianity at a Crossroads",
    "PHOENIX MARS MISSION: ONTO THE ICE": "Phoenix Mars Mission: Onto the Ice",
    "TWO WARS: NO MAIL, LOW MORALE": "Two Wars: No Mail, Low Morale",
    "ROAD TO ROME: WORLD WAR II": "Road to Rome: World War II",
    "NORTHERN NIGHTS, STARRY SKIES": "Northern Nights, Starry Skies",
    "THE GOLD ON MASTERPIECE": "The Gold on Masterpiece",
    "THE WAR THAT MADE AMERICA": "The War That Made America",
    "RESERVATION REDEMPTION": "Reservation Redemption",
    "RICK STEVES EUROPEAN CHRISTMAS": "Rick Steves' European Christmas",
    "RICK STEVES EUROPEAN FESTIVALS": "Rick Steves' European Festivals",
    "RICK STEVES ANDALUCIA: SOUTHERN SPAIN": "Rick Steves' Andalucia: Southern Spain",
    "RICK STEVES ART OF EUROPE": "Rick Steves' Art of Europe",
    "RICK STEVES BEST OF THE ALPS": "Rick Steves' Best of the Alps",
    "RICK STEVES BEST OF LONDON": "Rick Steves: Best of London",
    "RICK STEVES BEST OF PARIS": "Rick Steves: Best of Paris",
    "RICK STEVES EUROPE": "Rick Steves' Europe",
    "LUCY WORSLEY INVESTIGATES": "Lucy Worsley Investigates",
    "WALKING MY SISTER HOME": "Walking My Sister Home",
    "CARNIVAL OF THE ANIMALS": "Carnival of the Animals",
    "STORM ON SESAME STREET": "Storm on Sesame Street",
    "A CELEBRATION OF HANUKKAH": "A Celebration of Hanukkah",
    "EUROPEAN CHRISTMAS MARKETS": "European Christmas Markets",
    "CHRISTMAS ON THE DANUBE": "Christmas on the Danube",
    "SUPERTRAMP - LIVE IN PARIS": "Supertramp: Live in Paris",
    "RETURN OF THE TRUMPETERS": "Return of the Trumpeters",
    "YOU ARE CORDIALLY INVITED": "You Are Cordially Invited",
    "DEATH IN PARADISE": "Death in Paradise",
    "CORPSMAN! PEARL HARBOR": "Corpsman! Pearl Harbor",
    "REMEMBER PEARL HARBOR": "Remember Pearl Harbor",
    "THE PURSUIT OF HAPPINESS": "The Pursuit of Happiness",
    "THE GETTYSBURG STORY": "The Gettysburg Story",
    "THE PUZZLE LADY": "The Puzzle Lady",
    "PUZZLE LADY": "The Puzzle Lady",
    "CONCERT FOR GEORGE": "Concert for George",
    "KERRY: TIDES OF TIME": "Kerry: Tides of Time",
    "INSIDE THE NJAC": "Inside the NJAC",
    "THE MARINES": "The Marines",
    "WAR OF 1812": "War of 1812",
    "CHANGING SEAS": "Changing Seas",
    "A SACRED THREAD": "A Sacred Thread",
    "LAND RETURNS": "Land Returns",
    "GREEN PLANET": "Green Planet",
    "WILD HOPE": "Wild Hope",
    "NJ DECIDES": "NJ Decides",
    "PRECIPICE": "Precipice",
    "VELVET": "Velvet",
    "FILL": "Fill",
    "GEORGE WASHINGTON'S MOUNT VERNON: RESERVING THE LEGACY": "George Washington's Mount Vernon: Reserving the Legacy",
    "VOCES AMERICAN HISTORIA: THE UNTOLD HISTORY OF LATINOS": "VOCES American Historia: The Untold History of Latinos",
    "REMEMBER THEM WITH STEVE ADUBATO & JACQUI TRICARICO": "Remember Them with Steve Adubato and Jacqui Tricarico",
    "A SEASON TO REMEMBER THE BASEBALL BOYS OF MON CITY": "A Season to Remember: The Baseball Boys of Mon City",
    "LUCY WORSLEY INVESTIGATES: THE AMERICAN REVOLUTION": "Lucy Worsley Investigates: The American Revolution",
    "LIVE FROM THE LBJ LIBRARY WITH MARK UPDEGROVE": "Live From the LBJ Library With Mark Updegrove",
    "AMERIGO: THE SEARCH FOR THE AMERICAN DREAM": "Amerigo: The Search for the American Dream",
    "JUST A MORTAL MAN: THE JERRY LAWSON STORY": "Just a Mortal Man: The Jerry Lawson Story",
    "MISS SCARLET AND THE DUKE ON MASTERPIECE": "Miss Scarlet and the Duke on Masterpiece",
    "THE BLACK SOX SCANDAL: AMERICAN STORIES": "The Black Sox Scandal: American Stories",
    "10 MODERN MARVELS THAT CHANGED AMERICA": "10 Modern Marvels That Changed America",
    "DOWNTON ABBEY SEASON 2 ON MASTERPIECE": "Downton Abbey on Masterpiece",
    "CHRISTOPHER KIMBALL'S MILK STREET TV": "Christopher Kimball's Milk Street Television",
    "GRANTCHESTER SEASON 2 ON MASTERPIECE": "Grantchester on Masterpiece",
    "GRANTCHESTER SEASON 3 ON MASTERPIECE": "Grantchester on Masterpiece",
    "STATE OF AFFAIRS WITH STEVE ADUBATO": "State of Affairs with Steve Adubato",
    "XAVIER RIDDLE AND THE SECRET MUSEUM": "Xavier Riddle and the Secret Museum",
    "MARBLE HALL MURDERS ON MASTERPIECE": "Marble Hall Murders on Masterpiece",
    "ARTHUR AND THE HAUNTED TREE HOUSE": "Arthur and the Haunted Tree House",
    "MARLOW MURDER CLUB ON MASTERPIECE": "The Marlow Murder Club on Masterpiece",
    "SUPER WHY'S COMIC BOOK ADVENTURES": "Super Why's Comic Book Adventures",
    "CLASSICAL STRETCH: BY ESSENTRICS": "Classical Stretch: By Essentrics",
    "FONS & PORTER'S LOVE OF QUILTING": "Fons & Porter's Love of Quilting",
    "TELL ME MORE WITH KELLY CORRIGAN": "Tell Me More With Kelly Corrigan",
    "10 STREETS THAT CHANGED AMERICA": "10 Streets That Changed America",
    "SAMANTHA BROWN'S PLACES TO LOVE": "Samantha Brown's Places to Love",
    "SAMHAIN: THE BIRTH OF HALLOWEEN": "Samhain: The Birth of Halloween",
    "TABLE FOR ALI WITH BUKI ELEGBED": "Table for All with Buki Elegbede",
    "CUBA: THE FORGOTTEN REVOLUTION": "Cuba: The Forgotten Revolution",
    "EONS: LIFE AND DEATH ON PANGEA": "Eons: Life and Death on Pangea",
    "EPIC TRAIN JOURNEYS FROM ABOVE": "Epic Train Journeys From Above",
    "HISTORY WITH DAVID RUBENSTEIN": "History With David Rubenstein",
    "ONE ON ONE WITH STEVE ADUBATO": "One on One With Steve Adubato",
    "RE-EVOLUTION: THE CUBAN DREAM": "Re-evolution: The Cuban Dream",
    "STEVE ADUBATO'S MEDIA MATTERS": "Steve Adubato's Media Matters",
    "THINK TANK WITH STEVE ADUBATO": "Think Tank With Steve Adubato",
    "CELEBRITY ANTIQUES ROAD TRIP": "Celebrity Antiques Road Trip",
    "DOOK CHASE: A CHEF'S JOURNEY": "Dook Chase: A Chef's Journey",
    "GZERO WORLD WITH IAN BREMMER": "GZERO World With Ian Bremmer",
    "NEW YORK: A DOCUMENTARY FILM": "New York: A Documentary Film",
    "THE GAMES IN BLACK AND WHITE": "The Games in Black and White",
    "WILD KRATTS CREEPY CREATURES": "Wild Kratts: Creepy Creatures",
    "ALICE & JACK ON MASTERPIECE": "Alice & Jack on Masterpiece",
    "DANIEL TIGER'S NEIGHBORHOOD": "Daniel Tiger's Neighborhood",
    "HAPPY YOGA WITH SARAH STARR": "Happy Yoga With Sarah Starr",
    "NJ PBS NEWS WITH ROB NELSON": "NJ PBS News with Rob Nelson",
    "WEATHERED: EARTH'S EXTREMES": "Weathered: Earth's Extremes",
    "WORLD'S GREATEST CEMETERIES": "World's Greatest Cemeteries",
    "STORY IN THE PUBLIC SQUARE": "Story in the Public Square",
    "BBC NEWS: THE WORLD TODAY": "BBC News The World Today",
    "LUCY WORSLEY INVESITGATES": "Lucy Worsley Investigates",
    "SISTER BONIFACE MYSTERIES": "Sister Boniface Mysteries",
    "THE SHIP THAT TURNED BACK": "The Ship That Turned Back",
    "1955, SEVEN DAYS OF FALL": "1955, Seven Days of Fall",
    "LES STROUD'S SURVIVORMAN": "Les Stroud's Survivorman",
    "RICK STEVES BEST OF ROME": "Rick Steves: Best of Rome",
    "CHATSWORTH THROUGH TIME": "Chatsworth Through Time",
    "GROWING A GREENER WORLD": "Growing a Greener World",
    "THE AMERICAN REVOLUTION": "The American Revolution",
    "AMERICA'S TEST KITCHEN": "America's Test Kitchen",
    "BBC WORLD NEWS AMERICA": "BBC World News America",
    "MAIGRET ON MASTERPIECE": "Maigret on Masterpiece",
    "SARA'S WEEKNIGHT MEALS": "Sara's Weeknight Meals",
    "A CRAFTSMAN'S LEGACY": "A Craftsman's Legacy",
    "AMANPOUR AND COMPANY": "Amanpour and Company",
    "BANDS OF ENCHANTMENT": "Bands of Enchantment",
    "PATI'S MEXICAN TABLE": "Pati's Mexican Table",
    "REPORTERS ROUNDTABLE": "Reporters Roundtable",
    "THE MYSTERY OF MR. E": "The Mystery of Mr. E",
    "WORK IT OUT WOMBATS!": "Work It Out Wombats!",
    "COLORADO SOUNDSTAGE": "Colorado Soundstage",
    "RICK STEVES ICELAND": "Rick Steves Iceland",
    "RICK STEVES' EUROPE": "Rick Steves' Europe",
    "SECRETS OF THE DEAD": "Secrets of the Dead",
    "SONGS AT THE CENTER": "Songs at the Center",
    "AMANPOUR & COMPANY": "Amanpour and Company",
    "ASK THIS OLD HOUSE": "Ask This Old House",
    "AUSTIN CITY LIMITS": "Austin City Limits",
    "BUCK'S COUNTY, USA": "Bucks County, USA",
    "CARL THE COLLECTOR": "Carl the Collector",
    "DW FOCUS ON EUROPE": "Focus on Europe",
    "ELINOR WONDERS WHY": "Elinor Wonders Why",
    "FINDING YOUR ROOTS": "Finding Your Roots With Henry Louis Gates, Jr.",
    "GREAT PERFORMANCES": "Great Performances",
    "PATHWAY TO SUCCESS": "Pathway to Success",
    "THE DREAMERS AND I": "The Dreamers and I",
    "STATE OF THE ARTS": "State of the Arts",
    "LEVELING LINCOLN": "Leveling Lincoln",
    "LYLA IN THE LOOP": "Lyla in the Loop",
    "YOGA IN PRACTICE": "Yoga in Practice",
    "CAVERN SESSIONS": "The Caverns Sessions",
    "LIDIA'S KITCHEN": "Lidia's Kitchen",
    "MOLLY OF DENALI": "Molly of Denali",
    "SISTER BONIFACE": "Sister Boniface Mysteries",
    "WEATHER HUNTERS": "Weather Hunters",
    "MADE WITH LOVE": "Made With Love",
    "SIT AND BE FIT": "Sit and Be Fit",
    "THIS OLD HOUSE": "This Old House",
    "PBS ARTS TALK": "PBS Arts Talk",
    "ROSIE'S RULES": "Rosie's Rules",
    "SESAME STREET": "Sesame Street",
    "THE OPEN MIND": "The Open Mind",
    "WAI LANA YOGA": "Wai Lana Yoga",
    "ASIA INSIGHT": "Asia Insight",
    "DONKEY HODIE": "Donkey Hodie",
    "FATHER BROWN": "Father Brown",
    "FIT 2 STITCH": "Fit 2 Stitch",
    "GARDEN SMART": "Garden Smart",
    "PHOEBE & JAY": "Phoebe & Jay",
    "QUE PASA NJ": "Que Pasa NJ",
    "ALMA'S WAY": "Alma's Way",
    "LAST TWINS": "The Last Twins",
    "SOUNDCHECK": "Soundcheck",
    "IMMUTABLE": "Immutable",
    "MOTORWEEK": "MotorWeek",
    "WOODSONGS": "WoodSongs",
    "BERGERAC": "Bergerac",
    "ON STORY": "On Story: The Austin Film Festival Presents",
    "ARTHUR": "Arthur",
    "NATURE": "Nature",
    "FUZZ": "Fuzz",
    "NOVA": "NOVA"
}

KIDS_TITLES = {
    "Alma's Way", "Arthur", "Arthur and the Haunted Tree House", "Carl the Collector",
    "Daniel Tiger's Neighborhood", "Donkey Hodie", "Elinor Wonders Why", "Lyla in the Loop",
    "Molly of Denali", "Phoebe & Jay", "Rosie's Rules", "Sesame Street",
    "Super Why's Comic Book Adventures", "Weather Hunters", "Wild Kratts: Creepy Creatures",
    "Work It Out Wombats!", "Xavier Riddle and the Secret Museum",
    "Wild Kratts: A Creature Christmas", "Storm on Sesame Street", "Carnival of the Animals",
    "Arthur's Perfect Christmas", "An Arthur Thanksgiving",
}

# Read-only WNJT PBS responses fetched October 2, 2026. Both adjacent program
# and episode identities agree with the workbook; the unlabeled rows do not.
VERIFIED_BOUNDARIES = {"G138": "22:14", "L90": "14:14", "P138": "22:15"}
RUNTIME_CONFLICTS = {"AP94": "The prior Downton Abbey runtime exceeds its drawn slot."}
NOVEMBER_CONFLICTS = {
    "AD140": "The workbook states START AT 12:40 between 20:30 and 23:00; the explicit note conflicts with the surrounding clock labels.",
}


class Workbook:
    def __init__(self, source):
        self.sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
        if self.sha256 not in SOURCES:
            raise ValueError("The workbook hash does not match an approved revision.")
        self.month, self.revision, self.expected_blocks = SOURCES[self.sha256]
        with ZipFile(source) as archive:
            strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            self.strings = ["".join(node.itertext()) for node in strings.findall("m:si", NS)]
            styles = ET.fromstring(archive.read("xl/styles.xml"))
            self.formats = styles.find("m:cellXfs", NS)
            self.borders = styles.find("m:borders", NS)
            sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            self.cells = {node.get("r"): node for node in sheet.findall(".//m:c", NS)}
        for row in range(4, 148, 3):
            value = self.cells[f"A{row}"].find("m:v", NS)
            minutes = round(float(value.text) * 1440) % 1440
            if minutes != (row - 4) * 10:
                raise ValueError(f"The workbook clock layout differs at A{row}.")

    def text(self, address):
        cell = self.cells.get(address)
        if cell is None:
            return ""
        value = cell.find("m:v", NS)
        if value is None:
            return ""
        if cell.get("t") == "s":
            return self.strings[int(value.text)].strip()
        number_format = int(self.formats[int(cell.get("s", "0"))].get("numFmtId", "0"))
        # Numeric dates are repeat/first-air notes. A text cell with a date style
        # still contains text and must not be discarded.
        return "" if number_format in range(14, 23) else value.text.strip()

    def border(self, address, side):
        cell = self.cells.get(address)
        if cell is None:
            return False
        style = self.formats[int(cell.get("s", "0"))]
        border = self.borders[int(style.get("borderId", "0"))].find(f"m:{side}", NS)
        return border is not None and bool(border.get("style"))

    def blocks(self, column):
        start = 4
        for row in range(4, 148):
            if self.border(f"{column}{row}", "bottom") or self.border(f"{column}{row + 1}", "top") or row == 147:
                lines = [self.text(f"{column}{r}") for r in range(start, row + 1)]
                yield start, row, [line for line in lines if line]
                start = row + 1


def program(lines, month="2026-10"):
    text = " ".join(line for line in lines if not line.startswith(("START AT", "START LATE")))
    text = re.sub(r"\s+", " ", text)
    source_title = next((title for title in sorted(PROGRAM_TITLES, key=len, reverse=True) if text.startswith(title)), None)
    if source_title is None:
        raise ValueError(f"Unrecognized program: {text}")
    title = PROGRAM_TITLES[source_title]
    remaining = text[len(source_title):].strip()
    if month != "2026-10":
        remaining = re.sub(r"\([^)]*\)", "", remaining).strip()
    episode_code = re.match(r"^(\d{2,4})\b", remaining)
    code = episode_code.group(1) if episode_code else None
    if episode_code:
        remaining = remaining[episode_code.end():]
    # Operational, provider, repeat-date and promotion notes are not public copy.
    remaining = re.sub(r"\([^)]*\)", "", remaining)
    if month != "2026-10":
        remaining = re.split(r"\b(?:PT\.\s*\d+\s*/\s*\d+|APT BASE VERSION|NET\b|TBA\b)", remaining)[0]
        remaining = re.sub(r",\s*PT\.\s*(\d+)\b", r", Part \1", remaining)
        remaining = re.sub(r"\bFED\.\s*EAR\.", "", remaining)
        remaining = re.sub(r"\b\d{1,2}[- ](?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b46\d{3}\b", "", remaining, flags=re.I)
    remaining = re.split(r"\b(?:APTEX|NETA|PBS PLUS|NJ PBS|BBC|WNET|WETA|KNME|PLUS|FED EAR|FED EARLIER|RECORDED EARLIER|ONE DAY DELAY|FRIDAY FEED|SATURDAY FEED|SUNDAY FEED)\b", remaining)[0]
    remaining = re.sub(r"\b\d{1,2}[- ](?:SEP|OCT|NOV)\b", "", remaining, flags=re.I)
    remaining = re.sub(r"\s+", " ", remaining).strip(" -")
    if month != "2026-10":
        remaining = remaining.strip(" ,")
        if remaining == "NOT BUSINESS AS USUAL'":
            remaining = "NOT BUSINESS AS USUAL"
    is_kids = title in KIDS_TITLES or (title == "Nature" and "(EDITED VERSION)" in text and code == "4501")
    return {"title": title, "episodeCode": code,
            **({"episodeTitle": remaining} if remaining else {}), "isKids": is_kids}


def start_time(column, row, lines, month):
    address = f"{column}{row}"
    if "START LATE" in lines:
        return None
    if month == "2026-10" and address in RUNTIME_CONFLICTS:
        return None
    if month == "2026-11" and address in NOVEMBER_CONFLICTS:
        return None
    if month == "2026-10" and address in VERIFIED_BOUNDARIES:
        return VERIFIED_BOUNDARIES[address]
    explicit = next((re.fullmatch(r"START AT (\d{1,2}):(\d{2})", line) for line in lines if line.startswith("START AT")), None)
    if explicit:
        return f"{int(explicit[1]):02}:{explicit[2]}"
    if (row - 4) % 3:
        return None
    minutes = (row - 4) * 10
    return f"{minutes // 60:02}:{minutes % 60:02}"


def extract(source):
    workbook = Workbook(source)
    days = []
    unresolved = []
    for column in DAY_COLUMNS:
        serial = float(workbook.cells[f"{column}2"].find("m:v", NS).text)
        date = (dt.datetime(1899, 12, 30) + dt.timedelta(days=serial)).date().isoformat()
        if not date.startswith(workbook.month):
            continue
        entries = []
        for start, end, lines in workbook.blocks(column):
            entries.append({"cells": f"{column}{start}:{column}{end}",
                            "startTime": start_time(column, start, lines, workbook.month), **program(lines, workbook.month)})
        for index, entry in enumerate(entries):
            entry["endTime"] = entries[index + 1]["startTime"] if index + 1 < len(entries) else "24:00"
            if entry["startTime"] is None:
                previous = entries[index - 1]
                address = entry["cells"].split(":")[0]
                conflicts = {"2026-10": RUNTIME_CONFLICTS, "2026-11": NOVEMBER_CONFLICTS}
                reason = conflicts.get(workbook.month, {}).get(address)
                if not reason:
                    reason = ("The workbook says START LATE without an exact changeover time."
                              if workbook.text(address) == "START LATE"
                              else "The transition has no clock label or matching PBS airing.")
                unresolved.append({"date": date, "cells": [previous["cells"], entry["cells"]],
                                   "after": previous["title"], "before": entry["title"],
                                   "reason": reason})
        days.append({"date": date, "entries": entries})
    year, month = map(int, workbook.month.split("-"))
    if len(days) != calendar.monthrange(year, month)[1]:
        raise ValueError("The workbook does not cover every date in its month.")
    if sum(len(day["entries"]) for day in days) != workbook.expected_blocks:
        raise ValueError("The block count differs from the audited workbook.")
    return {"source": {"file": source.name, "sha256": workbook.sha256, "revision": workbook.revision,
                       "sheet": "Sheet1", "station": "WNJT", "timeZone": "America/New_York"},
            "verifiedPbsBoundaries": VERIFIED_BOUNDARIES if workbook.month == "2026-10" else {}, "unresolved": unresolved, "days": days}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--episode-metadata", type=Path,
                        help="Preserve an existing episode metadata source alongside the workbook.")
    args = parser.parse_args()
    data = extract(args.workbook)
    days, unresolved = len(data["days"]), len(data["unresolved"])
    if args.episode_metadata:
        data = {**json.loads(args.episode_metadata.read_text()), "workbook": data}
    args.output.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"Extracted {days} days; {unresolved} transitions remain unresolved.")
